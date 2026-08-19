const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const { normalizePdfPages } = require('./pdf-text-normalizer');
const { normalizeAllCapsTitle, shouldFilterChapter } = require('./chapter-utils');
const { PDF_MIN_SCORE, PDF_REVIEW_SCORE } = require('./import-validation');
const { fromLegacyChapters, hasMeaningfulNarration } = require('./extraction-result');

const DEFAULT_TARGET_CHARS = 18000;
const DEFAULT_MAX_CHARS = 30000;
const SCANNED_MIN_PAGES = 5;
const SCANNED_TINY_TOTAL_CHARS = 1500;
const SCANNED_AVG_CHARS_PER_PAGE = 80;
const LOW_TEXT_AVG_CHARS_PER_PAGE = 350;
const DEFAULT_OCR_TIMEOUT_MS = 20 * 60 * 1000;
// pdfinfo and ocrmypdf are already bounded; pdftotext was not. A crafted PDF
// can make poppler spin indefinitely, and because import slots are a limited
// pool, a handful of such files pin the importer permanently. Generous enough
// for a large scanned book, finite for everything else.
// A table of contents beyond this is not a book's, and each extra entry costs
// a full scan of the body pages.
const PDF_INFO_MAX_VALUE_CHARS = 2000;
const MAX_TOC_PLAN_ENTRIES = 2000;
// Roughly a second of matching on the measured hardware. A 600-page book with
// a 300-entry table of contents needs 180k, comfortably inside this.
const MAX_TOC_MATCH_OPERATIONS = 400_000;
const PDFTOTEXT_TIMEOUT_MS = Number(process.env.XANDRIO_PDFTOTEXT_TIMEOUT_MS) > 0
  ? Number(process.env.XANDRIO_PDFTOTEXT_TIMEOUT_MS)
  : 10 * 60 * 1000;

const CHAPTER_WORDS = [
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
  'eighteen', 'nineteen', 'twenty', 'the first'
].join('|');

const NUMBER_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
  'eighteen', 'nineteen', 'twenty', 'twenty-one', 'twenty-two', 'twenty-three',
  'twenty-four', 'twenty-five', 'twenty-six', 'twenty-seven', 'twenty-eight',
  'twenty-nine', 'thirty'
];

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

function xmlNumberAttribute(attributes, name) {
  const match = String(attributes || '').match(new RegExp(`\\b${name}="([^"]+)"`, 'i'));
  const value = match ? Number(match[1]) : NaN;
  return Number.isFinite(value) ? value : undefined;
}

function extractPagesFromBboxLayout(xml) {
  const pages = [];
  const pagePattern = /<page\b([^>]*)>([\s\S]*?)<\/page>/gi;
  let pageMatch;
  while ((pageMatch = pagePattern.exec(String(xml || '')))) {
    const pageNumber = pages.length + 1;
    const pageAttributes = pageMatch[1];
    const pageXml = pageMatch[2];
    const lines = [];
    const positionedLines = [];
    const linePattern = /<line\b([^>]*)>([\s\S]*?)<\/line>/gi;
    let lineMatch;
    while ((lineMatch = linePattern.exec(pageXml))) {
      const words = [];
      const positionedWords = [];
      const wordPattern = /<word\b([^>]*)>([\s\S]*?)<\/word>/gi;
      let wordMatch;
      while ((wordMatch = wordPattern.exec(lineMatch[2]))) {
        const word = decodeXmlText(wordMatch[2]).replace(/\s+/g, ' ').trim();
        if (word) {
          words.push(word);
          positionedWords.push({
            text: word,
            xMin: xmlNumberAttribute(wordMatch[1], 'xMin'),
            yMin: xmlNumberAttribute(wordMatch[1], 'yMin'),
            xMax: xmlNumberAttribute(wordMatch[1], 'xMax'),
            yMax: xmlNumberAttribute(wordMatch[1], 'yMax')
          });
        }
      }
      if (words.length > 0) {
        const text = words.join(' ');
        lines.push(text);
        const xMin = xmlNumberAttribute(lineMatch[1], 'xMin') ?? Math.min(...positionedWords.map(word => word.xMin).filter(Number.isFinite));
        const yMin = xmlNumberAttribute(lineMatch[1], 'yMin') ?? Math.min(...positionedWords.map(word => word.yMin).filter(Number.isFinite));
        const xMax = xmlNumberAttribute(lineMatch[1], 'xMax') ?? Math.max(...positionedWords.map(word => word.xMax).filter(Number.isFinite));
        const yMax = xmlNumberAttribute(lineMatch[1], 'yMax') ?? Math.max(...positionedWords.map(word => word.yMax).filter(Number.isFinite));
        positionedLines.push({
          text,
          xMin,
          yMin,
          xMax,
          yMax,
          height: Number.isFinite(yMin) && Number.isFinite(yMax) ? yMax - yMin : undefined,
          words: positionedWords
        });
      }
    }
    pages.push({
      pageNumber,
      text: lines.join('\n'),
      width: xmlNumberAttribute(pageAttributes, 'width'),
      height: xmlNumberAttribute(pageAttributes, 'height'),
      lines: positionedLines
    });
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
    producer: '',
    language: ''
  };

  // pdfinfo prints attacker-controlled document metadata into the same
  // "Key: value" stream as its own computed fields, and does not escape
  // newlines. A Title of "x\nEncrypted: yes" injects a field -- verified
  // against poppler 26.04, which emitted the forged Pages/Encrypted lines
  // ahead of its real ones.
  //
  // Poppler's field order is what disambiguates them. Every document-supplied
  // value (Title, Subject, Keywords, Author, Creator, Producer, dates) is
  // printed BEFORE the computed block (Pages, Encrypted, Page size, File size,
  // PDF version), and nothing after Encrypted comes from the document. So:
  //
  //   - computed fields take the LAST occurrence -- an injected copy can only
  //     appear earlier, from inside a metadata value;
  //   - document fields take the FIRST occurrence -- a duplicate appearing
  //     later cannot displace the genuine one.
  //
  // `encrypted` is the load-bearing one: it gates the encrypted-PDF rejection.
  const COMPUTED_KEYS = new Set(['pages', 'encrypted']);
  const seenDocumentKeys = new Set();
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1].trim().toLowerCase();
    if (!COMPUTED_KEYS.has(key)) {
      if (seenDocumentKeys.has(key)) continue;
      seenDocumentKeys.add(key);
    }
    const value = match[2].trim().slice(0, PDF_INFO_MAX_VALUE_CHARS);
    if (key === 'pages') info.pageCount = Number(value) || 0;
    if (key === 'encrypted') info.encrypted = /^yes/i.test(value);
    if (key === 'title') info.title = value;
    if (key === 'author') info.author = value;
    if (key === 'producer') info.producer = value;
    // Language reaches the library record and the PWA. Accept only a
    // BCP-47-shaped tag rather than whatever the document claims.
    if (key === 'language' && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(value)) info.language = value;
  }

  return info;
}

function usefulPdfMetadataValue(value) {
  const cleaned = String(value || '').replace(/\s+/g, ' ').trim();
  return cleaned && !/^(?:unknown|untitled|null|undefined|-+)$/i.test(cleaned);
}

function normalizedMetadataLine(line) {
  return String(line || '')
    .replace(/\s+/g, ' ')
    .replace(/^by\s+/i, '')
    .trim();
}

function isPageNumberLine(line) {
  return /^(?:\d{1,4}|[ivxlcdm]{1,12}|--\s*\d+\s+of\s+\d+\s*--)$/i.test(normalizedMetadataLine(line));
}

function looksLikePersonName(line) {
  const cleaned = normalizedMetadataLine(line);
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 6 || /[&$]|\b(?:press|publisher|publishing|inc|ltd|llc)\b/i.test(cleaned)) {
    return false;
  }
  return words.every(word => /^(?:[\p{Lu}][\p{L}'’.-]*|de|del|da|van|von|la)$/u.test(word));
}

function repeatedFrontMatterLines(pages) {
  const counts = new Map();
  for (const page of pages) {
    const seen = new Set();
    for (const rawLine of String(page.text || '').split(/\r?\n/)) {
      const line = normalizedMetadataLine(rawLine)
        .toLowerCase()
        .replace(/\b\d{1,4}\b/g, '#');
      if (line.length < 5 || seen.has(line)) continue;
      seen.add(line);
      counts.set(line, (counts.get(line) || 0) + 1);
    }
  }
  return new Set([...counts.entries()].filter(([, count]) => count >= 3).map(([line]) => line));
}

function titlePageMetadataFromPages(pages = []) {
  const repeated = repeatedFrontMatterLines(pages);
  let best = null;

  for (const page of pages.slice(0, 20)) {
    const lines = String(page.text || '')
      .split(/\r?\n/)
      .map(normalizedMetadataLine)
      .filter(line => {
        if (!line || isPageNumberLine(line)) return false;
        const key = line.toLowerCase().replace(/\b\d{1,4}\b/g, '#');
        return !repeated.has(key);
      });
    if (lines.length < 2 || lines.length > 14) continue;
    if (/\b(?:contents|copyright|all rights reserved|library of congress)\b/i.test(lines.join(' '))) continue;

    let authorIndex = -1;
    for (let index = lines.length - 1; index >= 1; index -= 1) {
      if (looksLikePersonName(lines[index])) {
        authorIndex = index;
        break;
      }
    }
    if (authorIndex < 1) continue;

    const author = lines[authorIndex];
    const titleLines = lines.slice(0, authorIndex)
      .filter(line => line.length >= 2 && !/\b(?:press|publisher|publishing)\b/i.test(line));
    if (titleLines.length === 0 || titleLines.length > 6) continue;
    const title = titleLines.length > 1
      ? `${titleLines[0]}: ${titleLines.slice(1).join(' ')}`
      : titleLines[0];
    const score = Math.min(100, title.length) + 40 - lines.length * 2;
    if (!best || score > best.score) best = { title, author, score };
  }

  return best || {};
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

function romanToNumber(value) {
  const values = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
  const roman = String(value || '').toLowerCase();
  if (!roman || !/^[ivxlcdm]+$/.test(roman)) return null;
  let total = 0;
  for (let index = 0; index < roman.length; index += 1) {
    const current = values[roman[index]];
    const next = values[roman[index + 1]] || 0;
    total += current < next ? -current : current;
  }
  return total || null;
}

function structureNumber(value) {
  const cleaned = String(value || '').trim().toLowerCase().replace(/\s+/g, '-');
  if (/^\d+$/.test(cleaned)) return Number(cleaned);
  const wordIndex = NUMBER_WORDS.indexOf(cleaned);
  if (wordIndex >= 0) return wordIndex;
  return romanToNumber(cleaned);
}

function numberWord(value) {
  return NUMBER_WORDS[Number(value)] || String(value || '');
}

function normalizeStructureText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function displayStructureTitle(prefix, subtitle, chapterNumber) {
  const cleanSubtitle = normalizeAllCapsTitle(String(subtitle || '').replace(/\s+/g, ' ').trim());
  if (/^chapter\b/i.test(prefix)) {
    return cleanSubtitle ? `Chapter ${chapterNumber}: ${cleanSubtitle}` : `Chapter ${chapterNumber}`;
  }
  if (/^part\b/i.test(prefix)) {
    const partToken = String(prefix).replace(/^part\s+/i, '').trim();
    const partName = /^\d+$/.test(partToken)
      ? partToken
      : partToken.toLowerCase().replace(/(^|-)([a-z])/g, (_match, separator, letter) => `${separator}${letter.toUpperCase()}`);
    return cleanSubtitle ? `Part ${partName}: ${cleanSubtitle}` : `Part ${partName}`;
  }
  const cleanPrefix = normalizeAllCapsTitle(prefix);
  return cleanSubtitle ? `${cleanPrefix}: ${cleanSubtitle}` : cleanPrefix;
}

function parseTocEntry(line) {
  const cleaned = String(line || '').replace(/\s+/g, ' ').trim();
  const marker = '(?:chapter\\s+(?:\\d+|[ivxlcdm]+|[a-z]+(?:[-\\s][a-z]+)?)|part\\s+(?:\\d+|[ivxlcdm]+|[a-z]+)|foreword|acknowledg(?:e)?ments?|about\\s+the\\s+author|introduction|afterword|notes|index)';
  const match = cleaned.match(new RegExp(`^(${marker})\\s*(.*?)\\s+((?:\\d+)|(?:[ivxlcdm]+))(?:\\s+[ivxlcdm]+)?$`, 'i'));
  if (!match) return null;

  const prefix = match[1];
  const subtitle = match[2];
  const pageLabel = match[3];
  const lowerPrefix = prefix.toLowerCase();
  const chapterNumber = lowerPrefix.startsWith('chapter ')
    ? structureNumber(prefix.replace(/^chapter\s+/i, ''))
    : null;
  if (lowerPrefix.startsWith('chapter ') && !Number.isFinite(chapterNumber)) return null;

  let kind = 'content';
  if (lowerPrefix.startsWith('part ')) kind = 'group';
  else if (/^(?:foreword|acknowledg|about\s+the\s+author)/i.test(prefix)) kind = 'frontmatter';
  else if (/^(?:notes|index)$/i.test(prefix)) kind = 'backmatter';

  return {
    kind,
    prefix,
    subtitle,
    chapterNumber,
    title: displayStructureTitle(prefix, subtitle, chapterNumber),
    printedPage: /^\d+$/.test(pageLabel) ? Number(pageLabel) : romanToNumber(pageLabel),
    printedPageStyle: /^\d+$/.test(pageLabel) ? 'arabic' : 'roman'
  };
}

function tocEntriesFromPage(page) {
  const entries = [];
  const lines = String(page.text || '').split(/\n+/).map(line => line.trim()).filter(Boolean);
  let pending = '';
  for (const line of lines) {
    const entry = parseTocEntry(line);
    if (entry) {
      entries.push(entry);
      pending = '';
      continue;
    }
    if (/^(?:chapter|part|foreword|acknowledg|about\s+the\s+author|introduction|afterword|notes|index)\b/i.test(line)) {
      pending = line;
      continue;
    }
    if (pending) {
      const continuedEntry = parseTocEntry(`${pending} ${line}`);
      if (continuedEntry) {
        entries.push(continuedEntry);
        pending = '';
        continue;
      }
      pending = `${pending} ${line}`;
      if (pending.length > 500) pending = '';
    }
    for (const match of line.matchAll(/\b(Afterword|Notes|Index)\s+(\d+|[ivxlcdm]+)\b/gi)) {
      const trailingEntry = parseTocEntry(`${match[1]} ${match[2]}`);
      if (trailingEntry) entries.push(trailingEntry);
    }
  }
  return entries;
}

function buildTocPlan(pages = []) {
  const candidates = pages.filter(page => page.pageNumber <= 40);
  const startIndex = candidates.findIndex(page => /\bcontents\b/i.test(page.text || '') && tocEntriesFromPage(page).length >= 2);
  if (startIndex < 0) return null;

  const entries = [];
  let tocEndPage = candidates[startIndex].pageNumber;
  for (let index = startIndex; index < Math.min(candidates.length, startIndex + 8); index += 1) {
    const pageEntries = tocEntriesFromPage(candidates[index]);
    if (index > startIndex && pageEntries.length === 0) break;
    entries.push(...pageEntries);
    tocEndPage = candidates[index].pageNumber;
  }

  const deduped = [];
  const seen = new Set();
  let partTitle;
  for (const entry of entries) {
    const key = entry.chapterNumber
      ? `chapter:${entry.chapterNumber}`
      : `${entry.kind}:${normalizeStructureText(entry.title)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (entry.kind === 'group') partTitle = entry.title;
    deduped.push({ ...entry, partTitle: entry.kind === 'group' ? undefined : partTitle });
  }

  const chapterEntries = deduped.filter(entry => Number.isFinite(entry.chapterNumber));
  if (chapterEntries.length < 2) return null;
  for (let index = 1; index < chapterEntries.length; index += 1) {
    if (chapterEntries[index].chapterNumber <= chapterEntries[index - 1].chapterNumber) return null;
  }
  return { entries: deduped, tocStartPage: candidates[startIndex].pageNumber, tocEndPage };
}

// `top` is the normalized head of the page. It is passed in rather than
// recomputed here because the caller scans every entry against every page:
// normalizing inside this function made the work entries x pages. Measured,
// 2000 entries against 2000 pages spent ~71 seconds in normalization alone,
// all of it on the one event loop this server has.
function matchesPlanEntry(top, entry) {
  if (!top) return false;
  const title = normalizeStructureText(entry.subtitle || entry.title);
  const titleWords = title.split(' ').filter(word => word.length >= 3).slice(0, 5);
  const titleMatches = titleWords.length === 0 || titleWords.filter(word => top.includes(word)).length >= Math.min(2, titleWords.length);

  if (Number.isFinite(entry.chapterNumber)) {
    const markerDigit = `chapter ${entry.chapterNumber}`;
    const markerWord = `chapter ${numberWord(entry.chapterNumber).replace(/-/g, ' ')}`;
    const numericHeading = top.startsWith(`${entry.chapterNumber} `);
    return titleMatches && (top.includes(markerDigit) || top.includes(markerWord) || numericHeading);
  }
  if (entry.kind === 'group') {
    const partToken = normalizeStructureText(entry.prefix);
    return top.includes(partToken) && titleMatches;
  }
  const prefix = normalizeStructureText(entry.prefix);
  return top.startsWith(prefix) || (top.includes(prefix) && titleMatches);
}

function mostCommonOffset(offsets) {
  const counts = new Map();
  for (const offset of offsets) counts.set(offset, (counts.get(offset) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || Math.abs(a[0]) - Math.abs(b[0]))[0]?.[0];
}

function resolveTocPlan(plan, pages = []) {
  const bodyPages = pages.filter(page => page.pageNumber > plan.tocEndPage);
  // Normalize each page once, not once per entry. An entry that matches
  // nothing scans every page, so the unmatched case -- the one a crafted
  // table of contents produces deliberately -- was the expensive one.
  const pageTops = bodyPages.map(page => ({
    pageNumber: page.pageNumber,
    top: normalizeStructureText(String(page.text || '').slice(0, 1800))
  }));
  // A real book's table of contents does not have thousands of entries. Above
  // this the plan is not a table of contents, and resolving it is pure cost.
  const planEntries = plan.entries.length > MAX_TOC_PLAN_ENTRIES
    ? plan.entries.slice(0, MAX_TOC_PLAN_ENTRIES)
    : plan.entries;
  if (planEntries.length !== plan.entries.length) {
    console.warn(
      `pdf-extraction: table-of-contents plan truncated from ${plan.entries.length} to ${MAX_TOC_PLAN_ENTRIES} entries`
    );
  }
  // Direct title matching is entries x pages. Capping the entry count alone
  // still leaves a large document expensive, so the *product* is what gets
  // bounded. Over budget the direct scan is skipped and resolution falls back
  // to printed-page offset inference below, which is linear. That costs some
  // matching precision on an implausibly large document and costs nothing on a
  // real book, which stays far under the budget.
  const directMatchAffordable = planEntries.length * pageTops.length <= MAX_TOC_MATCH_OPERATIONS;
  if (!directMatchAffordable) {
    console.warn(
      `pdf-extraction: skipping direct table-of-contents matching for ${planEntries.length} entries x ${pageTops.length} pages`
    );
  }
  const resolved = planEntries.map(entry => {
    const direct = directMatchAffordable
      ? pageTops.find(page => matchesPlanEntry(page.top, entry))
      : undefined;
    return direct ? { ...entry, directPdfPage: direct.pageNumber } : { ...entry };
  });
  const arabicOffsets = resolved
    .filter(entry => entry.directPdfPage && entry.printedPageStyle === 'arabic')
    .map(entry => entry.directPdfPage - entry.printedPage);
  const romanOffsets = resolved
    .filter(entry => entry.directPdfPage && entry.printedPageStyle === 'roman')
    .map(entry => entry.directPdfPage - entry.printedPage);
  const arabicOffset = mostCommonOffset(arabicOffsets);
  const romanOffset = mostCommonOffset(romanOffsets);

  for (const entry of resolved) {
    const offset = entry.printedPageStyle === 'roman' ? romanOffset : arabicOffset;
    if (Number.isFinite(offset) && Number.isFinite(entry.printedPage)) {
      const inferred = entry.printedPage + offset;
      if (pages.some(page => page.pageNumber === inferred)) {
        entry.pdfPage = entry.directPdfPage && Math.abs(entry.directPdfPage - inferred) <= 2
          ? entry.directPdfPage
          : inferred;
        entry.matched = Boolean(entry.directPdfPage && Math.abs(entry.directPdfPage - inferred) <= 2);
      }
    } else if (entry.directPdfPage) {
      entry.pdfPage = entry.directPdfPage;
      entry.matched = true;
    }
  }

  const ordered = resolved
    .filter(entry => Number.isFinite(entry.pdfPage))
    .sort((a, b) => a.pdfPage - b.pdfPage || (a.kind === 'group' ? -1 : 1));
  const playable = resolved.filter(entry => ['content', 'frontmatter'].includes(entry.kind));
  const resolvedPlayable = playable.filter(entry => Number.isFinite(entry.pdfPage));
  return {
    entries: ordered,
    confidence: playable.length ? resolvedPlayable.length / playable.length : 0,
    matchedEntries: resolved.filter(entry => entry.matched).length,
    resolvedEntries: resolvedPlayable.length,
    totalEntries: playable.length,
    pageOffset: arabicOffset
  };
}

function stripPlannedHeading(text, entry) {
  const blocks = String(text || '').split(/\n+/).map(block => block.trim()).filter(Boolean);
  let removed = 0;
  while (blocks.length > 1 && removed < 3) {
    const normalized = normalizeStructureText(blocks[0]);
    const title = normalizeStructureText(entry.title);
    const isHeading = normalized.length <= 140 && (
      title.includes(normalized) ||
      normalized.includes(normalizeStructureText(entry.prefix)) ||
      (Number.isFinite(entry.chapterNumber) && normalized === String(entry.chapterNumber))
    );
    if (!isHeading) break;
    blocks.shift();
    removed += 1;
  }
  return blocks.join('\n\n').trim();
}

function buildTocChapters(pages, options = {}) {
  const plan = buildTocPlan(pages);
  if (!plan) return null;
  const resolved = resolveTocPlan(plan, pages);
  if (resolved.confidence < 0.6 || resolved.resolvedEntries < 2) return null;

  // The printed page numbers behind entry.pdfPage are attacker-controlled text
  // on the TOC page, and nothing upstream forces them to be distinct. When many
  // entries resolve to one page, every entry finds no later start page, takes
  // pageEnd = last page, and is handed the entire document: N entries produced
  // N copies of the book (200 entries turned 0.86 MiB into 172 MiB, and five
  // extraction candidates run concurrently). Entries that share a start page
  // cannot be separated by page slicing anyway, so only the first of each
  // distinct page becomes a chapter.
  const seenStartPages = new Set();
  const chapters = [];
  for (let index = 0; index < resolved.entries.length; index += 1) {
    const entry = resolved.entries[index];
    if (!['content', 'frontmatter'].includes(entry.kind)) continue;
    if (seenStartPages.has(entry.pdfPage)) continue;
    seenStartPages.add(entry.pdfPage);
    // Plain scan rather than slice().find(): slice allocated a fresh array on
    // every iteration, which is a second quadratic term on the same input.
    let next = null;
    for (let ahead = index + 1; ahead < resolved.entries.length; ahead += 1) {
      if (resolved.entries[ahead].pdfPage > entry.pdfPage) { next = resolved.entries[ahead]; break; }
    }
    const pageEnd = next ? next.pdfPage - 1 : pages[pages.length - 1]?.pageNumber;
    const sectionPages = pages.filter(page => page.pageNumber >= entry.pdfPage && page.pageNumber <= pageEnd);
    let body = sectionPages.map(page => normalizePlainText(page.text)).filter(Boolean).join('\n\n').trim();
    body = stripPlannedHeading(body, entry);
    if (!body) continue;
    chapters.push({
      index: chapters.length,
      originalIndex: index,
      title: entry.title,
      text: body,
      estimatedDuration: estimateDuration(body),
      type: entry.kind === 'frontmatter' ? 'frontmatter' : 'content',
      extractionMode: 'pdf-authored-structure',
      pageStart: entry.pdfPage,
      pageEnd,
      printedPage: entry.printedPage,
      partTitle: entry.partTitle,
      sourceAnchor: { page: entry.pdfPage, heading: entry.title }
    });
  }
  if (chapters.length < 2) return null;
  return {
    chapters,
    chapterValidation: { valid: true },
    structure: {
      mode: 'toc',
      confidence: resolved.confidence,
      matchedEntries: resolved.matchedEntries,
      resolvedEntries: resolved.resolvedEntries,
      totalEntries: resolved.totalEntries,
      pageOffset: resolved.pageOffset,
      tocStartPage: plan.tocStartPage,
      tocEndPage: plan.tocEndPage
    }
  };
}

function outlineEntryFromTitle(title, parentPart) {
  const cleaned = String(title || '').replace(/\s+/g, ' ').trim();
  if (!cleaned || /^(?:page[_\s-]*[ivxlcdm\d]+|.*\.pdf|\d+)$/i.test(cleaned)) return null;
  const match = cleaned.match(
    /^(chapter\s+(?:\d+|[ivxlcdm]+|[a-z]+(?:[-\s][a-z]+)?)|part\s+(?:\d+|[ivxlcdm]+|[a-z]+)|foreword|acknowledg(?:e)?ments?|about\s+the\s+author|introduction|afterword|notes|index)(?:\s*[:—-]\s*|\s+)?(.*)$/i
  );
  if (!match) return null;
  const prefix = match[1];
  const subtitle = match[2] || '';
  const lowerPrefix = prefix.toLowerCase();
  const chapterNumber = lowerPrefix.startsWith('chapter ')
    ? structureNumber(prefix.replace(/^chapter\s+/i, ''))
    : null;
  let kind = 'content';
  if (lowerPrefix.startsWith('part ')) kind = 'group';
  else if (/^(?:foreword|acknowledg|about\s+the\s+author)/i.test(prefix)) kind = 'frontmatter';
  else if (/^(?:notes|index)$/i.test(prefix)) kind = 'backmatter';
  const entryTitle = displayStructureTitle(prefix, subtitle, chapterNumber);
  return {
    kind,
    prefix,
    subtitle,
    chapterNumber,
    title: entryTitle,
    partTitle: kind === 'group' ? undefined : parentPart
  };
}

async function readPdfOutline(pdfPath, fs = require('fs').promises) {
  let document;
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(await fs.readFile(pdfPath));
    document = await pdfjs.getDocument({ data, disableWorker: true, isEvalSupported: false }).promise;
    const outline = await document.getOutline();
    if (!Array.isArray(outline) || outline.length === 0) return null;
    const entries = [];

    async function visit(items, inheritedPart) {
      let sequentialPart = inheritedPart;
      for (const item of items || []) {
        const parsed = outlineEntryFromTitle(item.title, sequentialPart);
        let currentPart = sequentialPart;
        if (parsed?.kind === 'group') currentPart = parsed.title;
        if (parsed) {
          let destination = item.dest;
          if (typeof destination === 'string') destination = await document.getDestination(destination);
          const reference = Array.isArray(destination) ? destination[0] : null;
          let pageIndex = null;
          if (Number.isInteger(reference)) pageIndex = reference;
          else if (reference && typeof reference === 'object') {
            pageIndex = await document.getPageIndex(reference).catch(() => null);
          }
          if (Number.isInteger(pageIndex)) {
            entries.push({ ...parsed, pdfPage: pageIndex + 1 });
          }
        }
        if (Array.isArray(item.items) && item.items.length > 0) {
          await visit(item.items, currentPart);
        }
        if (parsed?.kind === 'group') sequentialPart = parsed.title;
      }
    }

    await visit(outline, undefined);
    const ordered = entries
      .filter(entry => Number.isFinite(entry.pdfPage))
      .sort((a, b) => a.pdfPage - b.pdfPage || (a.kind === 'group' ? -1 : 1));
    const playable = ordered.filter(entry => ['content', 'frontmatter'].includes(entry.kind));
    if (playable.length < 2) return null;
    for (let index = 1; index < playable.length; index += 1) {
      if (playable[index].pdfPage <= playable[index - 1].pdfPage) return null;
    }
    return { entries: ordered };
  } catch {
    return null;
  } finally {
    if (document) await document.destroy().catch(() => {});
  }
}

function buildOutlineChapters(pages, outlinePlan) {
  if (!outlinePlan?.entries?.length) return null;
  const chapters = [];
  for (let index = 0; index < outlinePlan.entries.length; index += 1) {
    const entry = outlinePlan.entries[index];
    if (!['content', 'frontmatter'].includes(entry.kind)) continue;
    const next = outlinePlan.entries.slice(index + 1).find(candidate => candidate.pdfPage > entry.pdfPage);
    const pageEnd = next ? next.pdfPage - 1 : pages[pages.length - 1]?.pageNumber;
    const sectionPages = pages.filter(page => page.pageNumber >= entry.pdfPage && page.pageNumber <= pageEnd);
    let body = sectionPages.map(page => normalizePlainText(page.text)).filter(Boolean).join('\n\n').trim();
    body = stripPlannedHeading(body, entry);
    if (!body) continue;
    chapters.push({
      index: chapters.length,
      originalIndex: index,
      title: entry.title,
      text: body,
      estimatedDuration: estimateDuration(body),
      type: entry.kind === 'frontmatter' ? 'frontmatter' : 'content',
      extractionMode: 'pdf-authored-structure',
      pageStart: entry.pdfPage,
      pageEnd,
      partTitle: entry.partTitle,
      sourceAnchor: { page: entry.pdfPage, heading: entry.title }
    });
  }
  if (chapters.length < 2) return null;
  return {
    chapters,
    chapterValidation: { valid: true },
    structure: {
      mode: 'outline',
      confidence: 1,
      matchedEntries: chapters.length,
      resolvedEntries: chapters.length,
      totalEntries: chapters.length
    }
  };
}

function positionedPageLines(page) {
  if (Array.isArray(page.lines) && page.lines.length > 0) return page.lines;
  return String(page.text || '')
    .split(/\r?\n/)
    .map(text => ({ text: text.trim() }))
    .filter(line => line.text);
}

function isLikelyHeadingLine(line, page, medianHeight) {
  const text = String(line?.text || '').trim();
  if (!text || text.length > 140) return false;
  const letters = text.match(/\p{L}/gu) || [];
  const uppercase = text.match(/\p{Lu}/gu) || [];
  if (letters.length >= 3 && uppercase.length / letters.length >= 0.65) return true;
  const lineHeight = Number(line?.height || 0);
  const centered = Number.isFinite(line?.xMin) && Number.isFinite(line?.xMax) && Number.isFinite(page?.width)
    ? Math.abs((line.xMin + line.xMax) / 2 - page.width / 2) <= page.width * 0.12
    : false;
  return centered && lineHeight > 0 && medianHeight > 0 && lineHeight >= medianHeight * 1.15;
}

function leadingChapterNumber(value) {
  const cleaned = String(value || '').trim();
  const tokens = cleaned.split(/\s+/);
  for (const size of [2, 1]) {
    const candidate = tokens.slice(0, size).join('-');
    const number = structureNumber(candidate);
    if (Number.isFinite(number) && number > 0) {
      return { number, rest: tokens.slice(size).join(' ') };
    }
  }
  return null;
}

function detectHeadingPlan(rawPages = []) {
  const entries = [];
  for (const page of rawPages) {
    const lines = positionedPageLines(page);
    const heights = lines.map(line => Number(line.height)).filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
    const medianHeight = heights.length ? heights[Math.floor(heights.length / 2)] : 0;
    const limit = Math.min(lines.length, 18);

    for (let index = 0; index < limit; index += 1) {
      const line = lines[index];
      const text = String(line.text || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (Number.isFinite(line.yMin) && Number.isFinite(page.height) && line.yMin > page.height * 0.65) continue;

      let prefix = '';
      let subtitle = '';
      let chapterNumber = null;
      let kind = 'content';
      const chapterMatch = text.match(/^chapter\s+(.+)$/i);
      if (chapterMatch) {
        const leading = leadingChapterNumber(chapterMatch[1]);
        if (!leading) continue;
        chapterNumber = leading.number;
        prefix = `Chapter ${chapterNumber}`;
        subtitle = leading.rest;
      } else if (/^\d{1,3}$/.test(text)) {
        chapterNumber = Number(text);
        prefix = `Chapter ${chapterNumber}`;
      } else {
        const structuralMatch = text.match(/^(part\s+(?:\d+|[ivxlcdm]+|[a-z]+)|foreword|acknowledg(?:e)?ments?|about\s+the\s+author|introduction|afterword|notes|index)\b\s*[:—-]?\s*(.*)$/i);
        if (!structuralMatch) continue;
        prefix = structuralMatch[1];
        subtitle = structuralMatch[2] || '';
        if (/^part\b/i.test(prefix)) kind = 'group';
        else if (/^(?:foreword|acknowledg|about\s+the\s+author)/i.test(prefix)) kind = 'frontmatter';
        else if (/^(?:notes|index)$/i.test(prefix)) kind = 'backmatter';
      }

      let cursor = index + 1;
      const titleLines = subtitle ? [subtitle] : [];
      while (cursor < Math.min(lines.length, index + 5) && titleLines.length < 3) {
        const candidate = lines[cursor];
        if (!isLikelyHeadingLine(candidate, page, medianHeight)) break;
        titleLines.push(candidate.text);
        cursor += 1;
      }
      subtitle = titleLines.join(' ').replace(/\s+/g, ' ').trim();
      if (Number.isFinite(chapterNumber) && !subtitle) continue;

      const entry = {
        kind,
        prefix,
        subtitle,
        chapterNumber,
        title: displayStructureTitle(prefix, subtitle, chapterNumber),
        pdfPage: page.pageNumber
      };
      entries.push(entry);
      break;
    }
  }

  const ordered = entries.sort((a, b) => a.pdfPage - b.pdfPage);
  const chapterEntries = ordered.filter(entry => Number.isFinite(entry.chapterNumber));
  if (chapterEntries.length < 2) return null;
  for (let index = 1; index < chapterEntries.length; index += 1) {
    if (chapterEntries[index].chapterNumber <= chapterEntries[index - 1].chapterNumber) return null;
  }
  let partTitle;
  return {
    entries: ordered.map(entry => {
      if (entry.kind === 'group') partTitle = entry.title;
      return { ...entry, partTitle: entry.kind === 'group' ? undefined : partTitle };
    })
  };
}

function buildDetectedHeadingChapters(pages, rawPages) {
  const plan = detectHeadingPlan(rawPages);
  if (!plan) return null;
  const chapters = [];
  for (let index = 0; index < plan.entries.length; index += 1) {
    const entry = plan.entries[index];
    if (!['content', 'frontmatter'].includes(entry.kind)) continue;
    const next = plan.entries.slice(index + 1).find(candidate => candidate.pdfPage > entry.pdfPage);
    const pageEnd = next ? next.pdfPage - 1 : pages[pages.length - 1]?.pageNumber;
    const sectionPages = pages.filter(page => page.pageNumber >= entry.pdfPage && page.pageNumber <= pageEnd);
    let body = sectionPages.map(page => normalizePlainText(page.text)).filter(Boolean).join('\n\n').trim();
    body = stripPlannedHeading(body, entry);
    if (!body) continue;
    chapters.push({
      index: chapters.length,
      originalIndex: index,
      title: entry.title,
      text: body,
      estimatedDuration: estimateDuration(body),
      type: entry.kind === 'frontmatter' ? 'frontmatter' : 'content',
      extractionMode: 'pdf-detected-headings',
      pageStart: entry.pdfPage,
      pageEnd,
      partTitle: entry.partTitle,
      sourceAnchor: { page: entry.pdfPage, heading: entry.title }
    });
  }
  if (chapters.length < 2) return null;
  return {
    chapters,
    chapterValidation: { valid: true },
    structure: {
      mode: 'detected-headings',
      confidence: 0.75,
      matchedEntries: chapters.length,
      resolvedEntries: chapters.length,
      totalEntries: chapters.length
    }
  };
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
  const structure = candidate.structure || {};
  if (structure.mode === 'outline' || structure.mode === 'toc') {
    score += 15;
    if (structure.confidence >= 0.8) score += 8;
  } else if (structure.mode === 'detected-headings') {
    score += Math.round(10 * Number(structure.confidence || 0));
  } else if (structure.mode === 'page-groups') {
    score -= 25;
    warnings.push('authored chapter structure was not recovered; using page groups');
  }

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
      avgPageChars,
      structureMode: structure.mode,
      structureConfidence: structure.confidence
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
    structure: selected.structure,
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
      structure: candidate.structure,
      error: candidate.error || undefined
    }))
  };
}

function buildPdfChaptersFromCandidate(sourceLabel, pages, text, normalization, mode, outlinePlan, rawPages = pages) {
  const outlineResult = buildOutlineChapters(pages, outlinePlan);
  if (outlineResult) {
    if (outlineResult.chapters[0]) {
      outlineResult.chapters[0].normalization = normalization;
      outlineResult.chapters[0].pdfExtractor = mode;
    }
    return outlineResult;
  }

  const tocResult = buildTocChapters(pages, { sourceLabel });
  if (tocResult) {
    if (tocResult.chapters[0]) {
      tocResult.chapters[0].normalization = normalization;
      tocResult.chapters[0].pdfExtractor = mode;
    }
    return tocResult;
  }

  const headingResult = buildDetectedHeadingChapters(pages, rawPages);
  if (headingResult) {
    if (headingResult.chapters[0]) {
      headingResult.chapters[0].normalization = normalization;
      headingResult.chapters[0].pdfExtractor = mode;
    }
    return headingResult;
  }

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
      chapterValidation: validation,
      structure: {
        mode: 'detected-headings',
        confidence: 0.7,
        resolvedEntries: guessedChapters.length,
        totalEntries: guessedChapters.length
      }
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
  return {
    chapters: grouped,
    chapterValidation: validation,
    structure: {
      mode: 'page-groups',
      confidence: 0,
      resolvedEntries: 0,
      totalEntries: 0,
      warning: validation.reason
    }
  };
}

async function buildPdfParseExtractionCandidate(pdfPath, sourceLabel, fs, pdfInfo = {}, outlinePlan) {
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
      sourcePages: pages,
      ...buildPdfChaptersFromCandidate(sourceLabel, pages, text, normalized.diagnostics, 'pdf-parse-normalized', outlinePlan, rawPages)
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
    maxBuffer: 100 * 1024 * 1024,
    timeout: PDFTOTEXT_TIMEOUT_MS,
    killSignal: 'SIGKILL'
  });
  const rawPages = String(stdout || '')
    .split('\f')
    .map((text, index) => ({ pageNumber: index + 1, text }))
    .filter(page => page.text.trim());
  return rawPages.length > 0 ? rawPages : [{ pageNumber: 1, text: stdout || '' }];
}

async function buildPdftotextExtractionCandidate(pdfPath, sourceLabel, variant = {}, pdfInfo = {}, outlinePlan) {
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
      sourcePages: pages,
      ...buildPdfChaptersFromCandidate(sourceLabel, pages, text, normalized.diagnostics, mode, outlinePlan, rawPages)
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

async function buildPdftotextBboxLayoutExtractionCandidate(pdfPath, sourceLabel, pdfInfo = {}, outlinePlan) {
  const mode = 'pdftotext-bbox-layout-normalized';
  try {
    const { stdout } = await execFileAsync('pdftotext', ['-bbox-layout', '-enc', 'UTF-8', pdfPath, '-'], {
      maxBuffer: 100 * 1024 * 1024,
      timeout: PDFTOTEXT_TIMEOUT_MS,
      killSignal: 'SIGKILL'
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
      sourcePages: pages,
      layoutPages: rawPages,
      ...buildPdfChaptersFromCandidate(sourceLabel, pages, text, normalized.diagnostics, mode, outlinePlan, rawPages)
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
    const structureRank = structure => ({ outline: 3, toc: 2, 'detected-headings': 1, 'page-groups': 0 }[structure?.mode] || 0);
    if (structureRank(b.structure) !== structureRank(a.structure)) {
      return structureRank(b.structure) - structureRank(a.structure);
    }
    if ((b.structure?.totalEntries || 0) !== (a.structure?.totalEntries || 0)) {
      return (b.structure?.totalEntries || 0) - (a.structure?.totalEntries || 0);
    }
    return (b.quality.stats?.totalChars || 0) - (a.quality.stats?.totalChars || 0);
  });
  return { selected: scored[0], candidates: scored };
}

async function runPdfExtractionCandidates(pdfPath, sourceLabel, fs, pdfInfo = {}, ocrReport) {
  const outlinePlan = await readPdfOutline(pdfPath, fs);
  const builtCandidates = await Promise.all([
    buildPdfParseExtractionCandidate(pdfPath, sourceLabel, fs, pdfInfo, outlinePlan),
    buildPdftotextExtractionCandidate(pdfPath, sourceLabel, { mode: 'pdftotext-normalized' }, pdfInfo, outlinePlan),
    buildPdftotextExtractionCandidate(pdfPath, sourceLabel, { mode: 'pdftotext-layout-normalized', args: ['-layout'] }, pdfInfo, outlinePlan),
    buildPdftotextExtractionCandidate(pdfPath, sourceLabel, { mode: 'pdftotext-raw-normalized', args: ['-raw'] }, pdfInfo, outlinePlan),
    buildPdftotextBboxLayoutExtractionCandidate(pdfPath, sourceLabel, pdfInfo, outlinePlan)
  ]);
  const { selected, candidates } = selectPdfExtractionCandidate(builtCandidates);

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

  const layoutCandidate = candidates.find(candidate => Array.isArray(candidate.layoutPages));
  const sourceDocument = {
    _pdfStructureVersion: 2,
    pageCount: pdfInfo.pageCount || selected.sourcePages?.length,
    pages: (selected.sourcePages || []).map(page => ({
      pageNumber: page.pageNumber,
      text: page.text
    })),
    layout: (layoutCandidate?.layoutPages || []).map(page => ({
      pageNumber: page.pageNumber,
      width: page.width,
      height: page.height,
      lines: (page.lines || []).map(line => ({
        text: line.text,
        xMin: line.xMin,
        yMin: line.yMin,
        xMax: line.xMax,
        yMax: line.yMax,
        height: line.height
      }))
    })),
    outline: outlinePlan || undefined,
    structure: selected.structure,
    extractor: selected.name
  };

  return { selected, candidates, status, extractionReport, sourceDocument };
}

function throwPdfExtractionStatusError(result) {
  const { selected, status, extractionReport } = result;

  // Confidence ranks candidates. It is not proof that retained readable text
  // is invalid. Only an extraction with no meaningful narration blocks here.
  if (hasMeaningfulNarration(selected?.chapters || [])) return;

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

async function extractPdfResult(pdfPath, options = {}) {
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

  Object.defineProperty(selected.chapters, 'sourceDocument', {
    value: result.sourceDocument,
    enumerable: false,
    configurable: true
  });
  return fromLegacyChapters(selected.chapters, {
    sourceFormat: 'pdf',
    sourceDocument: result.sourceDocument
  });
}

async function extractPdfChapters(pdfPath, options = {}) {
  return (await extractPdfResult(pdfPath, options)).chapters;
}

async function reprocessPdfSourceDocument(sourceDocument, options = {}) {
  if (!sourceDocument || !Array.isArray(sourceDocument.pages) || sourceDocument.pages.length === 0) {
    const error = new Error('XBook does not contain reprocessable PDF page data');
    error.code = 'PDF_SOURCE_DATA_UNAVAILABLE';
    throw error;
  }
  const pages = sourceDocument.pages.map(page => ({
    pageNumber: Number(page.pageNumber),
    text: String(page.text || '')
  }));
  const layoutByPage = new Map((sourceDocument.layout || []).map(page => [Number(page.pageNumber), page]));
  const rawPages = pages.map(page => {
    const layout = layoutByPage.get(page.pageNumber);
    return layout ? { ...layout, text: layout.lines?.map(line => line.text).join('\n') || page.text } : page;
  });
  const sourceLabel = options.sourceLabel || 'PDF';
  const text = pages.map(page => page.text).join('\n\n');
  const built = buildPdfChaptersFromCandidate(
    sourceLabel,
    pages,
    text,
    { reprocessedFromStoredPages: true },
    'xbook-pdf-reprocess',
    sourceDocument.outline,
    rawPages
  );
  const candidate = {
    ok: true,
    name: 'xbook-pdf-reprocess',
    mode: 'xbook-pdf-reprocess',
    stats: { pageCount: sourceDocument.pageCount || pages.length },
    ...built
  };
  candidate.quality = scorePdfExtractionCandidate(candidate);
  const status = classifyPdfExtractionStatus(candidate);
  const report = buildPdfExtractionReport(candidate, [candidate], status, {
    available: true,
    pageCount: sourceDocument.pageCount || pages.length
  });
  if (candidate.chapters[0]) candidate.chapters[0].pdfExtraction = report;
  throwPdfExtractionStatusError({
    selected: candidate,
    status,
    extractionReport: report
  });
  const updatedSourceDocument = {
    ...sourceDocument,
    _pdfStructureVersion: 2,
    structure: candidate.structure,
    extractor: candidate.name,
    reprocessedAt: new Date().toISOString()
  };
  Object.defineProperty(candidate.chapters, 'sourceDocument', {
    value: updatedSourceDocument,
    enumerable: false,
    configurable: true
  });
  return candidate.chapters;
}

async function extractPdfMetadata(pdfPath, fs = require('fs').promises) {
  try {
    const [pdfInfo, rawPages] = await Promise.all([
      readPdfInfo(pdfPath),
      runPdftotext(pdfPath, [
        '-layout',
        '-f', '1',
        '-l', '20',
        '-enc', 'UTF-8',
        pdfPath,
        '-'
      ]).catch(() => [])
    ]);
    const titlePage = titlePageMetadataFromPages(rawPages);
    const frontMatterText = rawPages.map(page => page.text || '').join('\n');
    const isbn = frontMatterText.match(/\bISBN(?:-1[03])?\s*:?\s*((?:97[89][-\s]?)?[\dX][\dX\s-]{8,20})/i)?.[1]
      ?.replace(/\s+/g, ' ')
      .trim();
    const publisher = frontMatterText.match(/\bPublished by\s+([^\n.]{3,120})/i)?.[1]?.trim();
    return {
      title: usefulPdfMetadataValue(pdfInfo.title)
        ? normalizedMetadataLine(pdfInfo.title)
        : (titlePage.title || path.basename(pdfPath, path.extname(pdfPath))),
      author: usefulPdfMetadataValue(pdfInfo.author)
        ? normalizedMetadataLine(pdfInfo.author)
        : (titlePage.author || undefined),
      publisher: publisher || undefined,
      isbn: isbn || undefined,
      language: usefulPdfMetadataValue(pdfInfo.language) ? pdfInfo.language : 'en',
      description: undefined
    };
  } catch (err) {
    console.error('PDF metadata extraction error:', err.message);
    return {
      title: path.basename(pdfPath, path.extname(pdfPath)),
      language: 'en'
    };
  }
}

module.exports = {
  extractPdfResult,
  extractPdfChapters,
  extractPdfMetadata,
  reprocessPdfSourceDocument,
  __test: {
    buildTocPlan,
    resolveTocPlan,
    MAX_TOC_PLAN_ENTRIES,
    MAX_TOC_MATCH_OPERATIONS,
    resolveTocPlan,
    buildTocChapters,
    parseTocEntry,
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
