#!/usr/bin/env node

/**
 * Benchmark PDF extraction quality before spending TTS time.
 *
 * Usage:
 *   node scripts/benchmark-pdf-extraction.js --input cache/book.pdf
 *   node scripts/benchmark-pdf-extraction.js --input cache/book.xbook.json --golden fixtures/book-golden.json
 *
 * Golden file shape:
 * {
 *   "mustInclude": ["phrase that must appear"],
 *   "mustNotInclude": ["repeated header"],
 *   "orderedPhrases": ["first phrase", "later phrase"],
 *   "chapterTitles": ["Chapter 1"],
 *   "samples": [{ "label": "p1", "text": "human corrected text sample" }]
 * }
 */

const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { normalizePdfText, normalizePdfPages } = require('../lib/pdf-text-normalizer');

const DEFAULT_TARGET_CHARS = 18000;
const DEFAULT_MAX_CHARS = 30000;
const DEFAULT_OCR_TIMEOUT_MS = 20 * 60 * 1000;

function parseArgs(argv) {
  const args = {
    input: '',
    golden: '',
    output: '',
    targetChars: DEFAULT_TARGET_CHARS,
    maxChars: DEFAULT_MAX_CHARS,
    ocr: false,
    ocrMode: process.env.XANDRIO_PDF_OCR_MODE || 'redo-ocr',
    ocrLang: process.env.XANDRIO_PDF_OCR_LANG || 'eng',
    ocrJobs: Number(process.env.XANDRIO_PDF_OCR_JOBS || 4),
    ocrTimeoutMs: Number(process.env.XANDRIO_PDF_OCR_TIMEOUT_MS || DEFAULT_OCR_TIMEOUT_MS)
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--input' || arg === '-i') {
      args.input = next;
      i++;
    } else if (arg === '--golden' || arg === '-g') {
      args.golden = next;
      i++;
    } else if (arg === '--output' || arg === '-o') {
      args.output = next;
      i++;
    } else if (arg === '--target-chars') {
      args.targetChars = Number(next);
      i++;
    } else if (arg === '--max-chars') {
      args.maxChars = Number(next);
      i++;
    } else if (arg === '--ocr') {
      args.ocr = true;
    } else if (arg === '--ocr-mode') {
      args.ocrMode = next;
      i++;
    } else if (arg === '--ocr-lang') {
      args.ocrLang = next;
      i++;
    } else if (arg === '--ocr-jobs') {
      args.ocrJobs = Number(next);
      i++;
    } else if (arg === '--ocr-timeout-ms') {
      args.ocrTimeoutMs = Number(next);
      i++;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.input) throw new Error('Missing --input');
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/benchmark-pdf-extraction.js --input <pdf-or-xbook> [--golden golden.json] [--output report.json]

Scores extraction/chunk quality before TTS:
  - candidate availability
  - total text and section lengths
  - suspicious titles, repeated lines, page-number/header artifacts
  - optional golden sample phrase/order checks

Raw PDF candidates:
  - pdf-parse
  - pdftotext, if installed
  - OCRmyPDF retry candidates when --ocr is passed

XBook candidates:
  - existing extracted artifact chapters
  - regrouped artifact text into PDF Part chunks
`);
}

function normalizeText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeForCompare(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
    const lines = [];
    const linePattern = /<line\b[^>]*>([\s\S]*?)<\/line>/gi;
    let lineMatch;
    while ((lineMatch = linePattern.exec(pageMatch[1]))) {
      const words = [];
      const wordPattern = /<word\b[^>]*>([\s\S]*?)<\/word>/gi;
      let wordMatch;
      while ((wordMatch = wordPattern.exec(lineMatch[1]))) {
        const word = decodeXmlText(wordMatch[1]).replace(/\s+/g, ' ').trim();
        if (word) words.push(word);
      }
      if (words.length > 0) lines.push(words.join(' '));
    }
    pages.push({ pageNumber: pages.length + 1, text: lines.join('\n') });
  }
  return pages;
}

function buildTextGroups(text, options = {}) {
  const cleaned = normalizeText(text);
  if (!cleaned) return [];

  const targetChars = options.targetChars || DEFAULT_TARGET_CHARS;
  const maxChars = options.maxChars || DEFAULT_MAX_CHARS;
  const chunks = [];
  let offset = 0;

  while (offset < cleaned.length) {
    let end = Math.min(offset + targetChars, cleaned.length);
    if (cleaned.length - end < 5000) end = cleaned.length;

    if (end < cleaned.length) {
      const windowEnd = Math.min(offset + maxChars, cleaned.length);
      const slice = cleaned.slice(offset, windowEnd);
      const targetOffset = end - offset;
      const paragraphBreak = slice.lastIndexOf('\n\n', targetOffset);
      const sentenceBreak = Math.max(
        slice.lastIndexOf('. ', targetOffset),
        slice.lastIndexOf('? ', targetOffset),
        slice.lastIndexOf('! ', targetOffset)
      );
      const breakAt = paragraphBreak > targetChars * 0.55
        ? paragraphBreak + 2
        : (sentenceBreak > targetChars * 0.55 ? sentenceBreak + 2 : targetOffset);
      end = offset + breakAt;
    }

    const body = cleaned.slice(offset, end).trim();
    if (body) {
      chunks.push({
        title: `PDF Part ${chunks.length + 1}`,
        text: body,
        estimatedDuration: Math.ceil(body.length / 1000 * 60),
        type: 'pdf-page-group'
      });
    }
    offset = end;
  }

  return chunks;
}

function suspiciousTitle(title) {
  const trimmed = String(title || '').trim();
  if (!trimmed) return true;
  if (/^chapter$/i.test(trimmed)) return true;
  if (/^(?:[A-Za-z]\s+){2,}[A-Za-z]$/.test(trimmed)) return true;
  return false;
}

function repeatedLineStats(text) {
  const counts = new Map();
  const lines = String(text || '')
    .split(/\n+/)
    .map(line => line.trim())
    .filter(line => line.length >= 4 && line.length <= 100);

  for (const line of lines) {
    const normalized = line.toLowerCase().replace(/\s+/g, ' ');
    counts.set(normalized, (counts.get(normalized) || 0) + 1);
  }

  const repeated = [...counts.entries()]
    .filter(([, count]) => count >= 4)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([line, count]) => ({ line, count }));

  return {
    lineCount: lines.length,
    repeated,
    repeatedLineRatio: lines.length ? repeated.reduce((sum, item) => sum + item.count, 0) / lines.length : 0
  };
}

function suspiciousOcrStats(text) {
  const matches = String(text || '').match(/\b(?:1s|th1s|hght|w1th|rnay|sorne|frorn)\b/gi) || [];
  const counts = new Map();
  for (const match of matches) {
    const key = match.toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return {
    count: matches.length,
    examples: [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([token, count]) => ({ token, count }))
  };
}

function scoreCandidate(candidate, golden = {}) {
  const chapters = candidate.chapters || [];
  const text = chapters.map(chapter => chapter.text || '').join('\n\n');
  const totalChars = text.trim().length;
  const pageCount = candidate.pageCount || candidate.stats?.pageCount || 0;
  const avgPageChars = pageCount ? totalChars / pageCount : 0;
  const chapterLengths = chapters.map(chapter => (chapter.text || '').trim().length);
  const maxSectionChars = Math.max(0, ...chapterLengths);
  const substantialSections = chapterLengths.filter(length => length >= 500).length;
  const suspiciousTitles = chapters
    .map((chapter, index) => ({ index, title: chapter.title || '' }))
    .filter(item => suspiciousTitle(item.title));
  const repeated = repeatedLineStats(text);
  const suspiciousOcr = suspiciousOcrStats(text);
  const normalized = normalizeForCompare(text);

  const goldenChecks = evaluateGolden(normalized, chapters, golden);
  const warnings = [];
  if (totalChars < 50000) warnings.push(`Low total text: ${totalChars} chars`);
  if (maxSectionChars > 120000) warnings.push(`Giant section: ${maxSectionChars} chars`);
  if (suspiciousTitles.length > 0) warnings.push(`${suspiciousTitles.length} suspicious section title(s)`);
  if (repeated.repeatedLineRatio > 0.15) warnings.push(`High repeated-line ratio: ${repeated.repeatedLineRatio.toFixed(2)}`);
  if (suspiciousOcr.count >= 25) warnings.push(`Many suspicious OCR-like tokens remain: ${suspiciousOcr.count}`);
  if (chapters.length <= 1 && totalChars > 120000) warnings.push('Single huge section');
  warnings.push(...goldenChecks.warnings);

  let score = 100;
  if (totalChars < 50000) score -= 35;
  if (maxSectionChars > 120000) score -= 25;
  if (chapters.length <= 1 && totalChars > 120000) score -= 20;
  score -= Math.min(20, suspiciousTitles.length * 5);
  score -= Math.min(15, Math.round(repeated.repeatedLineRatio * 100));
  score -= goldenChecks.penalty;
  score = Math.max(0, Math.min(100, score));
  const status = classifyCandidateStatus({ ok: candidate.ok, score, warnings, totalChars, pageCount, avgPageChars });

  return {
    name: candidate.name,
    ok: candidate.ok,
    error: candidate.error,
    score,
    status,
    mode: candidate.mode,
    ocr: candidate.ocr,
    stats: {
      chapters: chapters.length,
      totalChars,
      pageCount,
      avgPageChars,
      maxSectionChars,
      substantialSections,
      suspiciousTitles,
      repeated,
      suspiciousOcr,
      golden: goldenChecks.results,
      normalization: candidate.normalization || null
    },
    warnings,
    preview: chapters.slice(0, 5).map(chapter => ({
      title: chapter.title,
      chars: (chapter.text || '').length,
      estimatedDuration: chapter.estimatedDuration,
      start: String(chapter.text || '').slice(0, 180).replace(/\s+/g, ' ').trim()
    }))
  };
}

function classifyCandidateStatus({ ok, score, totalChars, pageCount, avgPageChars }) {
  if (!ok) return 'failed';
  if (pageCount >= 5 && (totalChars === 0 || totalChars < 500 || avgPageChars < 80)) return 'ocr-required';
  if (pageCount >= 20 && totalChars < 1500) return 'ocr-required';
  if (score < 55) return 'failed';
  if (score < 70) return 'review-needed';
  return 'ready';
}

function evaluateGolden(normalizedText, chapters, golden = {}) {
  const warnings = [];
  const results = {};
  let penalty = 0;

  const mustInclude = golden.mustInclude || [];
  results.mustInclude = mustInclude.map(phrase => {
    const ok = normalizedText.includes(normalizeForCompare(phrase));
    if (!ok) {
      penalty += 8;
      warnings.push(`Missing required phrase: ${phrase}`);
    }
    return { phrase, ok };
  });

  const mustNotInclude = golden.mustNotInclude || [];
  results.mustNotInclude = mustNotInclude.map(phrase => {
    const ok = !normalizedText.includes(normalizeForCompare(phrase));
    if (!ok) {
      penalty += 5;
      warnings.push(`Contains forbidden phrase: ${phrase}`);
    }
    return { phrase, ok };
  });

  const orderedPhrases = golden.orderedPhrases || [];
  let lastIndex = -1;
  results.orderedPhrases = orderedPhrases.map(phrase => {
    const index = normalizedText.indexOf(normalizeForCompare(phrase));
    const ok = index >= 0 && index > lastIndex;
    if (!ok) {
      penalty += 10;
      warnings.push(`Phrase missing or out of order: ${phrase}`);
    } else {
      lastIndex = index;
    }
    return { phrase, ok, index };
  });

  const expectedTitles = golden.chapterTitles || [];
  const actualTitles = chapters.map(chapter => normalizeForCompare(chapter.title));
  results.chapterTitles = expectedTitles.map(title => {
    const wanted = normalizeForCompare(title);
    const ok = actualTitles.some(actual => actual.includes(wanted));
    if (!ok) {
      penalty += 6;
      warnings.push(`Expected section title not found: ${title}`);
    }
    return { title, ok };
  });

  return { penalty, warnings, results };
}

async function pdfParseCandidate(input, options) {
  try {
    const { PDFParse } = require('pdf-parse');
    const data = await fs.readFile(input);
    const parser = new PDFParse({ data });
    try {
      const result = await parser.getText({ partial: [] });
      const rawPages = (result.pages || []).map((page, index) => ({
        pageNumber: page.pageNumber || index + 1,
        text: page.text || ''
      }));
      const rawText = rawPages.length
        ? rawPages.map(page => page.text).join('\n\n').trim()
        : (result.text || '');
      const normalized = normalizePdfPages(rawPages.length ? rawPages : [{ pageNumber: 1, text: result.text || '' }]);
      const normalizedText = normalized.pages.map(page => page.text).join('\n\n').trim();
      return [
        {
          name: 'pdf-parse-page-groups-raw',
          ok: true,
          mode: 'pdf-parse-raw',
          chapters: buildTextGroups(rawText, options)
        },
        {
          name: 'pdf-parse-page-groups-normalized',
          ok: true,
          mode: 'pdf-parse-normalized',
          normalization: normalized.diagnostics,
          chapters: buildTextGroups(normalizedText, options)
        }
      ];
    } finally {
      await parser.destroy();
    }
  } catch (err) {
    return [
      { name: 'pdf-parse-page-groups-raw', ok: false, mode: 'pdf-parse-raw', error: err.message, chapters: [] },
      { name: 'pdf-parse-page-groups-normalized', ok: false, mode: 'pdf-parse-normalized', error: err.message, chapters: [] }
    ];
  }
}

async function pdftotextCandidate(input, options, variant = {}) {
  const mode = variant.mode || 'pdftotext-normalized';
  const args = [...(variant.args || []), '-enc', 'UTF-8', input, '-'];
  try {
    const text = await runCommand('pdftotext', args);
    const rawPages = String(text || '')
      .split('\f')
      .map((pageText, index) => ({ pageNumber: index + 1, text: pageText }))
      .filter(page => page.text.trim());
    const pageCount = rawPages.length;
    const rawText = rawPages.length ? rawPages.map(page => page.text).join('\n\n') : text;
    const normalized = normalizePdfPages(rawPages.length ? rawPages : [{ pageNumber: 1, text }]);
    const normalizedText = normalized.pages.map(page => page.text).join('\n\n');
    return [
      {
        name: `poppler-${mode}-page-groups-raw`,
        ok: true,
        mode: `${mode}-raw-output`,
        pageCount,
        chapters: buildTextGroups(rawText, options)
      },
      {
        name: `poppler-${mode}-page-groups-normalized`,
        ok: true,
        mode,
        normalization: normalized.diagnostics,
        pageCount,
        chapters: buildTextGroups(normalizedText, options)
      }
    ];
  } catch (err) {
    return [
      {
        name: `poppler-${mode}-page-groups-raw`,
        ok: false,
        mode: `${mode}-raw-output`,
        error: err.message,
        chapters: []
      },
      {
        name: `poppler-${mode}-page-groups-normalized`,
        ok: false,
        mode,
        error: err.message,
        chapters: []
      }
    ];
  }
}

async function pdftotextBboxLayoutCandidate(input, options) {
  const mode = 'pdftotext-bbox-layout-normalized';
  try {
    const xml = await runCommand('pdftotext', ['-bbox-layout', '-enc', 'UTF-8', input, '-']);
    const rawPages = extractPagesFromBboxLayout(xml).filter(page => page.text.trim());
    const pageCount = rawPages.length;
    const rawText = rawPages.map(page => page.text).join('\n\n');
    const normalized = normalizePdfPages(rawPages.length ? rawPages : [{ pageNumber: 1, text: '' }]);
    const normalizedText = normalized.pages.map(page => page.text).join('\n\n');
    return [
      {
        name: 'poppler-pdftotext-bbox-layout-page-groups-raw',
        ok: true,
        mode: `${mode}-raw-output`,
        pageCount,
        chapters: buildTextGroups(rawText, options)
      },
      {
        name: 'poppler-pdftotext-bbox-layout-page-groups-normalized',
        ok: true,
        mode,
        normalization: normalized.diagnostics,
        pageCount,
        chapters: buildTextGroups(normalizedText, options)
      }
    ];
  } catch (err) {
    return [
      {
        name: 'poppler-pdftotext-bbox-layout-page-groups-raw',
        ok: false,
        mode: `${mode}-raw-output`,
        error: err.message,
        chapters: []
      },
      {
        name: 'poppler-pdftotext-bbox-layout-page-groups-normalized',
        ok: false,
        mode,
        error: err.message,
        chapters: []
      }
    ];
  }
}

async function pdfCandidates(input, options) {
  return [
    ...(await pdfParseCandidate(input, options)),
    ...(await pdftotextCandidate(input, options, { mode: 'pdftotext-normalized' })),
    ...(await pdftotextCandidate(input, options, { mode: 'pdftotext-layout-normalized', args: ['-layout'] })),
    ...(await pdftotextCandidate(input, options, { mode: 'pdftotext-raw-normalized', args: ['-raw'] })),
    ...(await pdftotextBboxLayoutCandidate(input, options))
  ];
}

function normalizeOcrMode(mode) {
  const value = String(mode || 'redo-ocr').trim().toLowerCase();
  return ['skip-text', 'redo-ocr', 'force-ocr'].includes(value) ? value : 'redo-ocr';
}

function ocrModeFlag(mode) {
  return {
    'skip-text': '--skip-text',
    'redo-ocr': '--redo-ocr',
    'force-ocr': '--force-ocr'
  }[normalizeOcrMode(mode)];
}

function buildOcrCommandArgs(input, outputPath, options) {
  const mode = normalizeOcrMode(options.ocrMode);
  const language = String(options.ocrLang || 'eng').trim() || 'eng';
  const jobs = Number.isFinite(options.ocrJobs) && options.ocrJobs > 0 ? Math.floor(options.ocrJobs) : 4;
  const args = [
    ocrModeFlag(mode),
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
    input,
    outputPath
  );
  return { args, mode, language, jobs };
}

async function ocrPdfCandidates(input, options) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-pdf-benchmark-ocr-'));
  const outputPath = path.join(tempDir, 'ocr-output.pdf');
  const command = buildOcrCommandArgs(input, outputPath, options);
  const timeoutMs = Number.isFinite(options.ocrTimeoutMs) && options.ocrTimeoutMs > 0 ? options.ocrTimeoutMs : DEFAULT_OCR_TIMEOUT_MS;
  const startedAt = Date.now();
  const ocr = {
    enabled: true,
    attempted: true,
    used: false,
    engine: 'ocrmypdf',
    mode: command.mode,
    language: command.language,
    jobs: command.jobs
  };

  try {
    await runCommand('ocrmypdf', command.args, { timeoutMs });
    ocr.used = true;
    ocr.durationMs = Date.now() - startedAt;
    return (await pdfCandidates(outputPath, options)).map(candidate => ({
      ...candidate,
      name: `ocr-${candidate.name}`,
      mode: `ocr-${candidate.mode}`,
      ocr
    }));
  } catch (err) {
    ocr.durationMs = Date.now() - startedAt;
    ocr.error = err.message;
    return [{
      name: 'ocrmypdf-retry',
      ok: false,
      mode: 'ocrmypdf',
      error: err.message,
      ocr,
      chapters: []
    }];
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGTERM');
          reject(new Error(`${command} timed out after ${options.timeoutMs} ms`));
        }, options.timeoutMs)
      : null;
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', err => {
      if (timeout) clearTimeout(timeout);
      reject(err);
    });
    child.on('close', code => {
      if (timeout) clearTimeout(timeout);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited ${code}: ${stderr || stdout}`));
    });
  });
}

async function xbookCandidates(input, options) {
  const artifact = JSON.parse(await fs.readFile(input, 'utf8'));
  const existing = Array.isArray(artifact.chapters) ? artifact.chapters : [];
  const text = existing.map(chapter => chapter.text || '').join('\n\n');
  const candidates = [
    {
      name: 'xbook-existing-sections',
      ok: true,
      mode: artifact.extraction?.mode || 'xbook-existing',
      chapters: existing
    },
    {
      name: 'xbook-regrouped-text',
      ok: true,
      mode: 'xbook-regrouped-text',
      chapters: buildTextGroups(text, options)
    }
  ];
  const isPdfArtifact = String(artifact.extraction?.sourceFormat || artifact.extraction?.originalFormat || artifact.metadata?.sourceFormat || '').toUpperCase() === 'PDF' ||
    String(artifact.extraction?.mode || '').includes('pdf');
  if (isPdfArtifact) {
    const normalized = normalizePdfText(text);
    candidates.push({
      name: 'xbook-regrouped-normalized-text',
      ok: true,
      mode: 'xbook-regrouped-normalized-text',
      normalization: normalized.diagnostics,
      chapters: buildTextGroups(normalized.text, options)
    });
  }
  return candidates;
}

async function loadGolden(goldenPath) {
  if (!goldenPath) return {};
  return JSON.parse(await fs.readFile(goldenPath, 'utf8'));
}

async function main() {
  const args = parseArgs(process.argv);
  const input = path.resolve(args.input);
  const golden = await loadGolden(args.golden ? path.resolve(args.golden) : '');
  const options = {
    targetChars: args.targetChars,
    maxChars: args.maxChars,
    ocrMode: args.ocrMode,
    ocrLang: args.ocrLang,
    ocrJobs: args.ocrJobs,
    ocrTimeoutMs: args.ocrTimeoutMs
  };
  const ext = path.basename(input).toLowerCase();

  if (!fsSync.existsSync(input)) {
    throw new Error(`Input not found: ${input}`);
  }

  let candidates;
  if (ext.endsWith('.xbook.json')) {
    candidates = await xbookCandidates(input, options);
  } else if (ext.endsWith('.pdf')) {
    candidates = await pdfCandidates(input, options);
    if (args.ocr) {
      candidates.push(...await ocrPdfCandidates(input, options));
    }
  } else {
    throw new Error('Input must be a .pdf or .xbook.json file');
  }

  const report = {
    input,
    golden: args.golden ? path.resolve(args.golden) : null,
    generatedAt: new Date().toISOString(),
    candidates: candidates.map(candidate => scoreCandidate(candidate, golden))
  };
  report.best = report.candidates
    .filter(candidate => candidate.ok)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.warnings.length !== b.warnings.length) return a.warnings.length - b.warnings.length;
      const aNormalized = a.stats.normalization ? 1 : 0;
      const bNormalized = b.stats.normalization ? 1 : 0;
      return bNormalized - aNormalized;
    })[0]?.name || null;

  const json = JSON.stringify(report, null, 2);
  if (args.output) {
    await fs.writeFile(path.resolve(args.output), json);
  }

  printSummary(report);
  if (args.output) console.log(`\nReport written to ${path.resolve(args.output)}`);
}

function printSummary(report) {
  console.log(`PDF extraction benchmark: ${report.input}`);
  if (report.best) console.log(`Best candidate: ${report.best}`);
  for (const candidate of report.candidates) {
    console.log(`\n${candidate.name}: ${candidate.ok ? `${candidate.score}/100` : 'FAILED'}`);
    if (candidate.error) console.log(`  error: ${candidate.error}`);
    console.log(`  chapters: ${candidate.stats.chapters}`);
    console.log(`  chars: ${candidate.stats.totalChars}`);
    if (candidate.status) console.log(`  status: ${candidate.status}`);
    if (candidate.ocr) {
      console.log(`  ocr: ${candidate.ocr.used ? 'used' : 'not used'} (${candidate.ocr.engine}, ${candidate.ocr.mode}, ${candidate.ocr.language})`);
      if (candidate.ocr.error) console.log(`  ocr error: ${candidate.ocr.error}`);
    }
    if (candidate.stats.pageCount) console.log(`  pages: ${candidate.stats.pageCount} (${Math.round(candidate.stats.avgPageChars)} chars/page)`);
    console.log(`  max section: ${candidate.stats.maxSectionChars}`);
    if (candidate.stats.normalization) {
      console.log(`  normalization: ${JSON.stringify(candidate.stats.normalization)}`);
    }
    if (candidate.warnings.length) {
      console.log('  warnings:');
      candidate.warnings.forEach(warning => console.log(`    - ${warning}`));
    }
    if (candidate.preview.length) {
      console.log('  preview:');
      candidate.preview.forEach(item => {
        console.log(`    - ${item.title} (${item.chars} chars): ${item.start}`);
      });
    }
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
