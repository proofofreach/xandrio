const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const { normalizePdfPages } = require('./pdf-text-normalizer');
const { normalizeAllCapsTitle, shouldFilterChapter } = require('./chapter-utils');
const { PDF_MIN_SCORE, PDF_REVIEW_SCORE } = require('./import-validation');

const DEFAULT_TARGET_CHARS = 18000;
const DEFAULT_MAX_CHARS = 30000;
const SCANNED_MIN_PAGES = 5;
const SCANNED_TINY_TOTAL_CHARS = 1500;
const SCANNED_AVG_CHARS_PER_PAGE = 80;
const LOW_TEXT_AVG_CHARS_PER_PAGE = 350;
const DEFAULT_OCR_TIMEOUT_MS = 20 * 60 * 1000;

const CHAPTER_WORDS = [
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
  'eighteen', 'nineteen', 'twenty', 'the first'
].join('|');

function normalizePlainText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function estimateDuration(text) {
  return Math.ceil(String(text || '').length / 1000 * 60);
}

function decodeXmlText(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&amp;/g, '&');
}

function extractPagesFromBboxLayout(xml) {
  const pages = [];
  const pagePattern = /<page\b[^>]*>([\s\S]*?)<\/page>/gi;
  let pageMatch;
  while ((pageMatch = pagePattern.exec(String(xml || '')))) {
    const pageNumber = pages.length + 1;
    const pageXml = pageMatch[1];
    const lines = [];
    const linePattern = /<line\b[^>]*>([\s\S]*?)<\/line>/gi;
    let lineMatch;
    while ((lineMatch = linePattern.exec(pageXml))) {
      const words = [];
      const wordPattern = /<word\b[^>]*>([\s\S]*?)<\/word>/gi;
      let wordMatch;
      while ((wordMatch = wordPattern.exec(lineMatch[1]))) {
        const word = decodeXmlText(wordMatch[1]).replace(/\s+/g, ' ').trim();
        if (word) words.push(word);
      }
      if (words.length > 0) lines.push(words.join(' '));
    }
    pages.push({ pageNumber, text: lines.join('\n') });
  }
  return pages;
}

function parsePdfInfo(stdout) {
  const info = {
    available: true,
    pageCount: 0,
    encrypted: false,
    title: '',
    author: '',
    producer: ''
  };

  for (const line of String(stdout || '').split(/\r?\n/)) {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1].trim().toLowerCase();
    const value = match[2].trim();
    if (key === 'pages') info.pageCount = Number(value) || 0;
    if (key === 'encrypted') info.encrypted = /^yes/i.test(value);
    if (key === 'title') info.title = value;
    if (key === 'author') info.author = value;
    if (key === 'producer') info.producer = value;
  }

  return info;
}

async function readPdfInfo(pdfPath) {
  try {
    const { stdout } = await execFileAsync('pdfinfo', [pdfPath], {
      timeout: 10000,
      maxBuffer: 1024 * 1024
    });
    return parsePdfInfo(stdout);
  } catch (err) {
    return {
      available: false,
      pageCount: 0,
      encrypted: false,
      error: err.message
    };
  }
}

function isTruthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function isPdfOcrEnabled(options = {}) {
  if (typeof options.ocr === 'boolean') return options.ocr;
  return isTruthyEnv(process.env.XANDRIO_PDF_OCR);
}

function getPdfOcrMode(options = {}) {
  const mode = String(options.ocrMode || process.env.XANDRIO_PDF_OCR_MODE || 'redo-ocr').trim().toLowerCase();
  return ['skip-text', 'redo-ocr', 'force-ocr'].includes(mode) ? mode : 'redo-ocr';
}

function getPdfOcrLanguage(options = {}) {
  return String(options.ocrLanguage || process.env.XANDRIO_PDF_OCR_LANG || 'eng').trim() || 'eng';
}

function getPdfOcrJobs(options = {}) {
  const fallback = Math.max(1, Math.min(4, os.cpus().length || 1));
  const jobs = Number(options.ocrJobs || process.env.XANDRIO_PDF_OCR_JOBS || fallback);
  if (!Number.isFinite(jobs) || jobs <= 0) return fallback;
  return Math.max(1, Math.floor(jobs));
}

function getPdfOcrTimeoutMs(options = {}) {
  const timeout = Number(options.ocrTimeoutMs || process.env.XANDRIO_PDF_OCR_TIMEOUT_MS || DEFAULT_OCR_TIMEOUT_MS);
  if (!Number.isFinite(timeout) || timeout <= 0) return DEFAULT_OCR_TIMEOUT_MS;
  return timeout;
}

function buildOcrUnavailableReport(reason) {
  return {
    enabled: false,
    attempted: false,
    used: false,
    reason
  };
}

async function defaultPdfOcrRunner({ inputPath, outputPath, mode, language, jobs, timeoutMs }) {
  const args = buildPdfOcrArgs({ inputPath, outputPath, mode, language, jobs });
  const { stdout, stderr } = await execFileAsync('ocrmypdf', args, {
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024
  });
  return {
    outputPath,
    engine: 'ocrmypdf',
    stdout,
    stderr
  };
}

function buildPdfOcrArgs({ inputPath, outputPath, mode, language, jobs }) {
  const modeFlag = {
    'skip-text': '--skip-text',
    'redo-ocr': '--redo-ocr',
    'force-ocr': '--force-ocr'
  }[mode] || '--redo-ocr';
  const args = [
    modeFlag,
    '--rotate-pages'
  ];

  if (mode !== 'redo-ocr') {
    args.push('--deskew');
  }

  args.push(
    '--optimize', '0',
    '--output-type', 'pdf',
    '--jobs', String(jobs),
    '-l', language,
    inputPath,
    outputPath
  );
  return args;
}

function friendlyOcrError(err) {
  if (err && err.code === 'ENOENT') {
    return 'ocrmypdf is not installed or not on PATH';
  }
  if (err && err.killed && err.signal === 'SIGTERM') {
    return 'OCR timed out';
  }
  return err?.message || 'OCR failed';
}

async function runPdfOcr(pdfPath, options = {}) {
  const fs = options.fs || require('fs').promises;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-pdf-ocr-'));
  const outputPath = path.join(tempDir, 'ocr-output.pdf');
  const mode = getPdfOcrMode(options);
  const language = getPdfOcrLanguage(options);
  const jobs = getPdfOcrJobs(options);
  const timeoutMs = getPdfOcrTimeoutMs(options);
  const runner = options.ocrRunner || defaultPdfOcrRunner;
  const startedAt = Date.now();

  try {
    const result = await runner({
      inputPath: pdfPath,
      outputPath,
      mode,
      language,
      jobs,
      timeoutMs,
      fs
    });
    const finalOutputPath = result?.outputPath || outputPath;
    await fs.stat(finalOutputPath);
    return {
      outputPath: finalOutputPath,
      tempDir,
      report: {
        enabled: true,
        attempted: true,
        used: true,
        engine: result?.engine || 'ocrmypdf',
        mode,
        language,
        jobs,
        durationMs: Date.now() - startedAt
      }
    };
  } catch (err) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    const wrapped = new Error(friendlyOcrError(err));
    wrapped.cause = err;
    wrapped.pdfOcr = {
      enabled: true,
      attempted: true,
      used: false,
      engine: 'ocrmypdf',
      mode,
      language,
      jobs,
      durationMs: Date.now() - startedAt,
      error: wrapped.message
    };
    throw wrapped;
  }
}

function titleLinePattern() {
  return new RegExp(
    [
      '^\\s*(?:',
      `chapter\\s+(?:\\d+|[ivxlcdm]+|${CHAPTER_WORDS})\\b[^\\n]{0,100}`,
      '|(?:part|book|volume)\\s+(?:\\d+|[ivxlcdm]+|one|two|three|four|five)\\b[^\\n]{0,100}',
      '|(?:prologue|epilogue|preface|introduction|afterword|acknowledg(?:e)?ments?)\\b[^\\n]{0,80}',
      ')\\s*$'
    ].join(''),
    'i'
  );
}

function candidateTitleFromLine(line) {
  const cleaned = String(line || '').replace(/\s+/g, ' ').trim();
  if (!cleaned || cleaned.length > 120) return '';
  if (titleLinePattern().test(cleaned)) return normalizeAllCapsTitle(cleaned);
  return '';
}

function buildTextChapters(text, options = {}) {
  const sourceLabel = options.sourceLabel || 'Book';
  const cleaned = normalizePlainText(text);
  if (!cleaned) return [];

  const lines = cleaned.split('\n');
  const starts = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const title = candidateTitleFromLine(rawLine);
    if (title) {
      const prevBlank = i === 0 || !String(lines[i - 1] || '').trim();
      const nextHasBody = lines.slice(i + 1, Math.min(lines.length, i + 6)).some(line => String(line || '').trim().length > 40);
      if (prevBlank || nextHasBody) starts.push({ offset, title });
    }
    offset += rawLine.length + 1;
  }

  if (starts.length < 2) {
    return [{
      index: 0,
      originalIndex: 0,
      title: sourceLabel,
      text: cleaned,
      estimatedDuration: estimateDuration(cleaned),
      type: 'content'
    }];
  }

  const chapters = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i].offset;
    const end = i + 1 < starts.length ? starts[i + 1].offset : cleaned.length;
    const chunk = cleaned.slice(start, end).trim();
    const chunkLines = chunk.split('\n').map(line => line.trim()).filter(Boolean);
    const title = normalizeAllCapsTitle(chunkLines[0] || starts[i].title || `${sourceLabel} ${i + 1}`);
    const body = chunkLines.slice(1).join('\n\n').trim() || chunk;
    chapters.push({
      index: chapters.length,
      originalIndex: i,
      title,
      text: body,
      estimatedDuration: estimateDuration(body),
      type: shouldFilterChapter({ title, text: body }) ? 'frontmatter' : 'content'
    });
  }

  return chapters;
}

function buildPdfPageGroups(pages, options = {}) {
  const sourceLabel = options.sourceLabel || 'PDF';
  const targetChars = options.targetChars || DEFAULT_TARGET_CHARS;
  const maxChars = options.maxChars || DEFAULT_MAX_CHARS;
  const cleanedPages = pages
    .map(page => ({
      pageNumber: page.pageNumber,
      text: normalizePlainText(page.text)
    }))
    .filter(page => page.text.length > 0);

  const chapters = [];
  let current = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length === 0) return;
    const pageStart = current[0].pageNumber;
    const pageEnd = current[current.length - 1].pageNumber;
    const body = current.map(page => page.text).join('\n\n').trim();
    chapters.push({
      index: chapters.length,
      originalIndex: chapters.length,
      title: pageStart === pageEnd ? `Page ${pageStart}` : `Pages ${pageStart}-${pageEnd}`,
      text: body,
      estimatedDuration: estimateDuration(body),
      type: 'pdf-page-group',
      pageStart,
      pageEnd
    });
    current = [];
    currentChars = 0;
  };

  for (const page of cleanedPages) {
    if (current.length > 0 && (currentChars >= targetChars || currentChars + page.text.length > maxChars)) {
      flush();
    }
    current.push(page);
    currentChars += page.text.length;
  }
  flush();

  if (chapters.length > 0) return chapters;

  const fallbackText = cleanedPages.map(page => page.text).join('\n\n').trim();
  return fallbackText ? [{
    index: 0,
    originalIndex: 0,
    title: sourceLabel,
    text: fallbackText,
    estimatedDuration: estimateDuration(fallbackText),
    type: 'pdf-page-group'
  }] : [];
}

function extractChapterNumber(title = '') {
  const match = String(title).match(/\bchapter\s+(\d+)\b/i);
  return match ? Number(match[1]) : null;
}

function validatePdfChapterGuess(chapters) {
  if (!Array.isArray(chapters) || chapters.length < 2) return { valid: false, reason: 'not enough detected sections' };

  const contentChapters = chapters.filter(chapter => String(chapter.text || '').trim().length >= 500);
  const maxChars = Math.max(...chapters.map(ch => (ch.text || '').length), 0);
  if (contentChapters.length < 2) return { valid: false, reason: 'not enough substantial detected sections' };
  if (maxChars > 120000) return { valid: false, reason: 'detected a giant PDF section' };

  if (chapters.some(ch => /^chapter$/i.test(String(ch.title || '').trim()))) {
    return { valid: false, reason: 'detected bare chapter title' };
  }

  const numbers = chapters
    .map(ch => extractChapterNumber(ch.title))
    .filter(Number.isFinite);

  for (let i = 1; i < numbers.length; i++) {
    if (numbers[i] < numbers[i - 1]) {
      return { valid: false, reason: `detected out-of-order chapter numbers (${numbers[i - 1]} before ${numbers[i]})` };
    }
  }

  return { valid: true };
}

function repeatedLineStats(text) {
  const counts = new Map();
  const lines = String(text || '')
    .split(/\n+/)
    .map(line => line.trim())
    .filter(line => line.length >= 4 && line.length <= 100);

  for (const line of lines) {
    const key = line.toLowerCase().replace(/\b\d{1,5}\b/g, '#').replace(/\s+/g, ' ');
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const repeatedCount = [...counts.values()]
    .filter(count => count >= 4)
    .reduce((sum, count) => sum + count, 0);

  return {
    lineCount: lines.length,
    repeatedLineRatio: lines.length ? repeatedCount / lines.length : 0
  };
}

function scorePdfExtractionCandidate(candidate) {
  if (!candidate.ok) {
    return { score: 0, warnings: [candidate.error || 'candidate failed'], stats: {} };
  }

  const chapters = candidate.chapters || [];
  const text = chapters.map(chapter => chapter.text || '').join('\n\n');
  const totalChars = text.trim().length;
  const chapterLengths = chapters.map(chapter => (chapter.text || '').trim().length);
  const maxSectionChars = Math.max(0, ...chapterLengths);
  const repeated = repeatedLineStats(text);
  const suspiciousOcr = (text.match(/\b(?:1s|th1s|hght|w1th|rnay|sorne|frorn)\b/gi) || []).length;
  const replacementChars = (text.match(/\uFFFD/g) || []).length;
  const latinWords = (text.match(/[A-Za-z]{3,}/g) || []).length;
  const nonWhitespace = (text.match(/\S/g) || []).length;
  const lettersAndNumbers = (text.match(/[\p{L}\p{N}]/gu) || []).length;
  const alnumRatio = nonWhitespace ? lettersAndNumbers / nonWhitespace : 0;
  const avgPageChars = candidate.stats?.pageCount ? totalChars / candidate.stats.pageCount : 0;
  const warnings = [];
  let score = 100;

  if (totalChars < 50000) {
    score -= 35;
    warnings.push(`low text length: ${totalChars}`);
  }
  if (candidate.stats?.pageCount >= 20 && avgPageChars < LOW_TEXT_AVG_CHARS_PER_PAGE) {
    score -= 30;
    warnings.push(`very low extracted text per page: ${Math.round(avgPageChars)}`);
  }
  if (maxSectionChars > 120000) {
    score -= 25;
    warnings.push(`giant section: ${maxSectionChars}`);
  }
  if (chapters.length <= 1 && totalChars > 120000) {
    score -= 20;
    warnings.push('single huge section');
  }
  if (repeated.repeatedLineRatio > 0.15) {
    score -= Math.min(20, Math.round(repeated.repeatedLineRatio * 100));
    warnings.push(`high repeated-line ratio: ${repeated.repeatedLineRatio.toFixed(2)}`);
  }
  if (suspiciousOcr >= 25) {
    score -= Math.min(15, Math.ceil(suspiciousOcr / 25) * 3);
    warnings.push(`suspicious OCR-like tokens: ${suspiciousOcr}`);
  }
  if (replacementChars > 0) {
    score -= Math.min(15, replacementChars);
    warnings.push(`replacement characters: ${replacementChars}`);
  }
  if (alnumRatio < 0.55) {
    score -= 20;
    warnings.push(`low alphanumeric ratio: ${alnumRatio.toFixed(2)}`);
  }
  if (latinWords < 5000 && totalChars > 50000) {
    score -= 10;
    warnings.push(`low word count: ${latinWords}`);
  }
  if (candidate.mode && candidate.mode.includes('normalized')) score += 2;
  if (candidate.mode && candidate.mode.includes('layout') && repeated.repeatedLineRatio < 0.08) score += 1;

  return {
    score: Math.max(0, Math.min(100, score)),
    warnings,
    stats: {
      ...(candidate.stats || {}),
      totalChars,
      chapters: chapters.length,
      maxSectionChars,
      repeatedLineRatio: repeated.repeatedLineRatio,
      suspiciousOcr,
      replacementChars,
      alnumRatio,
      latinWords,
      avgPageChars
    }
  };
}

function isLikelyScannedPdf(stats = {}) {
  const pageCount = Number(stats.pageCount || 0);
  const totalChars = Number(stats.totalChars || 0);
  const avgPageChars = Number(stats.avgPageChars || 0);

  if (pageCount < SCANNED_MIN_PAGES) return false;
  if (totalChars === 0) return true;
  if (totalChars > 0 && totalChars < 500) return true;
  if (avgPageChars > 0 && avgPageChars < SCANNED_AVG_CHARS_PER_PAGE) return true;
  if (pageCount >= 20 && totalChars < SCANNED_TINY_TOTAL_CHARS) return true;
  return false;
}

function classifyPdfExtractionStatus(selected) {
  if (!selected || !selected.ok) {
    return { status: 'failed', reason: selected?.error || 'all extraction candidates failed' };
  }

  const quality = selected.quality || scorePdfExtractionCandidate(selected);
  const stats = quality.stats || {};
  if (isLikelyScannedPdf(stats)) {
    return {
      status: 'ocr-required',
      reason: `very low extracted text density (${Math.round(stats.avgPageChars || 0)} chars/page across ${stats.pageCount || 0} pages)`
    };
  }

  if (quality.score < PDF_MIN_SCORE) {
    return {
      status: 'failed',
      reason: quality.warnings.join('; ') || 'low extraction confidence'
    };
  }

  if (quality.score < PDF_REVIEW_SCORE || (selected.chapterValidation && !selected.chapterValidation.valid)) {
    return {
      status: 'review-needed',
      reason: selected.chapterValidation && !selected.chapterValidation.valid
        ? selected.chapterValidation.reason
        : `score below review threshold (${quality.score})`
    };
  }

  return { status: 'ready', reason: '' };
}

function buildPdfExtractionReport(selected, candidates, status, pdfInfo = {}) {
  const stats = selected?.quality?.stats || {};
  const warnings = [...(selected?.quality?.warnings || [])];
  if (status.reason && status.status !== 'ready') warnings.push(status.reason);

  return {
    selected: selected.name,
    status: status.status,
    statusReason: status.reason || undefined,
    score: selected.quality.score,
    warnings: [...new Set(warnings)],
    pageCount: stats.pageCount || pdfInfo.pageCount || undefined,
    avgPageChars: Number.isFinite(stats.avgPageChars) ? stats.avgPageChars : undefined,
    totalChars: stats.totalChars,
    pdfInfo: pdfInfo.available ? {
      pageCount: pdfInfo.pageCount || undefined,
      encrypted: pdfInfo.encrypted || undefined,
      producer: pdfInfo.producer || undefined
    } : undefined,
    candidates: candidates.map(candidate => ({
      name: candidate.name,
      ok: candidate.ok,
      score: candidate.quality.score,
      warnings: candidate.quality.warnings,
      stats: candidate.quality.stats,
      error: candidate.error || undefined
    }))
  };
}

function buildPdfChaptersFromCandidate(sourceLabel, pages, text, normalization, mode) {
  const guessedChapters = buildTextChapters(text, { sourceLabel });
  const validation = validatePdfChapterGuess(guessedChapters);

  if (validation.valid) {
    return {
      chapters: guessedChapters.map((chapter, index) => ({
        ...chapter,
        type: chapter.type || 'pdf-detected-chapter',
        extractionMode: 'pdf-detected-chapters',
        pdfExtractor: mode,
        normalization: index === 0 ? normalization : undefined
      })),
      chapterValidation: validation
    };
  }

  const grouped = buildPdfPageGroups(pages.length > 0 ? pages : [{ pageNumber: 1, text }], {
    sourceLabel
  });
  if (grouped[0]) {
    grouped[0].normalization = normalization;
    grouped[0].pdfExtractor = mode;
    grouped[0].chapterDetectionRejected = validation.reason;
  }
  return { chapters: grouped, chapterValidation: validation };
}

async function buildPdfParseExtractionCandidate(pdfPath, sourceLabel, fs, pdfInfo = {}) {
  const { PDFParse } = require('pdf-parse');
  const data = await fs.readFile(pdfPath);
  const parser = new PDFParse({ data });
  try {
    const result = await parser.getText({ partial: [] });
    const rawPages = (result.pages || []).map((page, index) => ({
      pageNumber: page.pageNumber || index + 1,
      text: page.text || ''
    }));
    const normalized = normalizePdfPages(rawPages.length > 0 ? rawPages : [{ pageNumber: 1, text: result.text || '' }]);
    const pages = normalized.pages;
    const text = pages.map(page => page.text).join('\n\n');
    return {
      ok: true,
      name: 'pdf-parse-normalized',
      mode: 'pdf-parse-normalized',
      normalization: normalized.diagnostics,
      stats: { pageCount: pdfInfo.pageCount || pages.length },
      ...buildPdfChaptersFromCandidate(sourceLabel, pages, text, normalized.diagnostics, 'pdf-parse-normalized')
    };
  } catch (err) {
    return {
      ok: false,
      name: 'pdf-parse-normalized',
      mode: 'pdf-parse-normalized',
      error: err.message,
      chapters: []
    };
  } finally {
    await parser.destroy();
  }
}

async function runPdftotext(pdfPath, args) {
  const { stdout } = await execFileAsync('pdftotext', args, {
    maxBuffer: 100 * 1024 * 1024
  });
  const rawPages = String(stdout || '')
    .split('\f')
    .map((text, index) => ({ pageNumber: index + 1, text }))
    .filter(page => page.text.trim());
  return rawPages.length > 0 ? rawPages : [{ pageNumber: 1, text: stdout || '' }];
}

async function buildPdftotextExtractionCandidate(pdfPath, sourceLabel, variant = {}, pdfInfo = {}) {
  const mode = variant.mode || 'pdftotext-normalized';
  try {
    const rawPages = await runPdftotext(pdfPath, [...(variant.args || []), '-enc', 'UTF-8', pdfPath, '-']);
    const normalized = normalizePdfPages(rawPages);
    const pages = normalized.pages;
    const text = pages.map(page => page.text).join('\n\n');
    return {
      ok: true,
      name: mode,
      mode,
      normalization: normalized.diagnostics,
      stats: { pageCount: pdfInfo.pageCount || pages.length },
      ...buildPdfChaptersFromCandidate(sourceLabel, pages, text, normalized.diagnostics, mode)
    };
  } catch (err) {
    return {
      ok: false,
      name: mode,
      mode,
      error: err.message,
      chapters: []
    };
  }
}

async function buildPdftotextBboxLayoutExtractionCandidate(pdfPath, sourceLabel, pdfInfo = {}) {
  const mode = 'pdftotext-bbox-layout-normalized';
  try {
    const { stdout } = await execFileAsync('pdftotext', ['-bbox-layout', '-enc', 'UTF-8', pdfPath, '-'], {
      maxBuffer: 100 * 1024 * 1024
    });
    const rawPages = extractPagesFromBboxLayout(stdout).filter(page => page.text.trim());
    const normalized = normalizePdfPages(rawPages.length ? rawPages : [{ pageNumber: 1, text: '' }]);
    const pages = normalized.pages;
    const text = pages.map(page => page.text).join('\n\n');
    return {
      ok: true,
      name: mode,
      mode,
      normalization: normalized.diagnostics,
      stats: { pageCount: pdfInfo.pageCount || pages.length },
      ...buildPdfChaptersFromCandidate(sourceLabel, pages, text, normalized.diagnostics, mode)
    };
  } catch (err) {
    return {
      ok: false,
      name: mode,
      mode,
      error: err.message,
      chapters: []
    };
  }
}

function selectPdfExtractionCandidate(candidates) {
  const scored = candidates.map(candidate => ({
    ...candidate,
    quality: scorePdfExtractionCandidate(candidate)
  }));
  scored.sort((a, b) => {
    if (b.quality.score !== a.quality.score) return b.quality.score - a.quality.score;
    return (b.quality.stats?.totalChars || 0) - (a.quality.stats?.totalChars || 0);
  });
  return { selected: scored[0], candidates: scored };
}

async function runPdfExtractionCandidates(pdfPath, sourceLabel, fs, pdfInfo = {}, ocrReport) {
  const { selected, candidates } = selectPdfExtractionCandidate(await Promise.all([
    buildPdfParseExtractionCandidate(pdfPath, sourceLabel, fs, pdfInfo),
    buildPdftotextExtractionCandidate(pdfPath, sourceLabel, { mode: 'pdftotext-normalized' }, pdfInfo),
    buildPdftotextExtractionCandidate(pdfPath, sourceLabel, { mode: 'pdftotext-layout-normalized', args: ['-layout'] }, pdfInfo),
    buildPdftotextExtractionCandidate(pdfPath, sourceLabel, { mode: 'pdftotext-raw-normalized', args: ['-raw'] }, pdfInfo),
    buildPdftotextBboxLayoutExtractionCandidate(pdfPath, sourceLabel, pdfInfo)
  ]));

  if (!selected || !selected.ok) {
    const errors = candidates.map(candidate => `${candidate.name}: ${candidate.error || 'failed'}`).join('; ');
    throw new Error(`PDF extraction failed: ${errors}`);
  }

  const status = classifyPdfExtractionStatus(selected);
  const extractionReport = buildPdfExtractionReport(selected, candidates, status, pdfInfo);
  if (ocrReport) extractionReport.ocr = ocrReport;

  if (selected.chapters[0]) {
    selected.chapters[0].pdfExtraction = extractionReport;
  }

  return { selected, candidates, status, extractionReport };
}

function throwPdfExtractionStatusError(result) {
  const { selected, status, extractionReport } = result;

  if (status.status === 'ocr-required') {
    const ocrError = extractionReport.ocr?.error ? ` OCR failed: ${extractionReport.ocr.error}.` : '';
    const err = new Error(`PDF appears to be scanned or image-only; OCR is required before audiobook generation.${ocrError}`);
    err.statusCode = 400;
    err.code = 'PDF_OCR_REQUIRED';
    err.pdfExtraction = extractionReport;
    throw err;
  }

  if (status.status === 'failed') {
    const err = new Error(`PDF extraction quality too low (${selected.quality.score}): ${selected.quality.warnings.join('; ') || status.reason || 'low confidence'}`);
    err.statusCode = 400;
    err.code = 'PDF_TEXT_LOW_QUALITY';
    err.pdfExtraction = extractionReport;
    throw err;
  }

  if (selected.quality.score < PDF_MIN_SCORE) {
    const err = new Error(`PDF extraction quality too low (${selected.quality.score}): ${selected.quality.warnings.join('; ') || 'low confidence'}`);
    err.statusCode = 400;
    err.code = 'PDF_TEXT_LOW_QUALITY';
    err.pdfExtraction = extractionReport;
    throw err;
  }
}

async function maybeRetryPdfExtractionWithOcr(pdfPath, sourceLabel, fs, result, options = {}) {
  if (result.status.status !== 'ocr-required') return result;

  if (!isPdfOcrEnabled(options)) {
    result.extractionReport.ocr = buildOcrUnavailableReport('Set XANDRIO_PDF_OCR=true to OCR scanned PDFs before import');
    if (result.selected.chapters[0]) result.selected.chapters[0].pdfExtraction = result.extractionReport;
    return result;
  }

  let ocrRun = null;
  try {
    ocrRun = await runPdfOcr(pdfPath, { ...options, fs });
    const ocrPdfInfo = await readPdfInfo(ocrRun.outputPath);
    return await runPdfExtractionCandidates(
      ocrRun.outputPath,
      sourceLabel,
      fs,
      ocrPdfInfo,
      ocrRun.report
    );
  } catch (err) {
    result.extractionReport.ocr = err.pdfOcr || {
      enabled: true,
      attempted: true,
      used: false,
      error: friendlyOcrError(err)
    };
    if (result.selected.chapters[0]) result.selected.chapters[0].pdfExtraction = result.extractionReport;
    return result;
  } finally {
    if (ocrRun?.tempDir) {
      await fs.rm(ocrRun.tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function extractPdfChapters(pdfPath, options = {}) {
  const sourceLabel = options.sourceLabel || path.basename(pdfPath, path.extname(pdfPath));
  const fs = options.fs || require('fs').promises;
  const pdfInfo = options.pdfInfo || await readPdfInfo(pdfPath);
  const result = await maybeRetryPdfExtractionWithOcr(
    pdfPath,
    sourceLabel,
    fs,
    await runPdfExtractionCandidates(pdfPath, sourceLabel, fs, pdfInfo),
    options
  );

  throwPdfExtractionStatusError(result);

  const { selected } = result;

  if (selected.chapterValidation && !selected.chapterValidation.valid && options.warn !== false) {
    console.warn(`PDF chapter detection rejected for ${sourceLabel} (${selected.name}): ${selected.chapterValidation.reason}. Using page groups.`);
  }

  return selected.chapters;
}

async function extractPdfMetadata(pdfPath, fs = require('fs').promises) {
  try {
    const { PDFParse } = require('pdf-parse');
    const data = await fs.readFile(pdfPath);
    const parser = new PDFParse({ data });
    try {
      const result = await parser.getText({ first: 1 });
      const firstLine = (result.text || '').split(/\r?\n/).map(line => line.trim()).find(Boolean);
      return {
        title: firstLine || path.basename(pdfPath, path.extname(pdfPath)),
        author: undefined,
        language: 'en',
        description: undefined
      };
    } finally {
      await parser.destroy();
    }
  } catch (err) {
    console.error('PDF metadata extraction error:', err.message);
    return {
      title: path.basename(pdfPath, path.extname(pdfPath)),
      language: 'en'
    };
  }
}

module.exports = {
  extractPdfChapters,
  extractPdfMetadata,
  __test: {
    buildTextChapters,
    buildPdfPageGroups,
    buildPdfOcrArgs,
    classifyPdfExtractionStatus,
    extractPagesFromBboxLayout,
    getPdfOcrLanguage,
    getPdfOcrMode,
    isLikelyScannedPdf,
    isPdfOcrEnabled,
    parsePdfInfo,
    runPdfOcr,
    readPdfInfo,
    validatePdfChapterGuess,
    scorePdfExtractionCandidate,
    selectPdfExtractionCandidate
  }
};
