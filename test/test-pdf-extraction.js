const {
  normalizePdfText,
  normalizePdfPages
} = require('../lib/pdf-text-normalizer');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { extractPdfChapters, __test } = require('../lib/pdf-extraction');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  PASS ${message}`);
  } else {
    failed++;
    console.error(`  FAIL ${message}`);
  }
}

function section(name) {
  console.log(`\n--- ${name} ---`);
}

function escapePdfText(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function writePdfObject(objects, id, body) {
  objects[id] = `${id} 0 obj\n${body}\nendobj\n`;
}

function repeatedLines(line, count) {
  return Array.from({ length: count }, () => line);
}

function buildSimplePdf(pages) {
  const objects = [];
  const pageRefs = [];
  writePdfObject(objects, 1, '<< /Type /Catalog /Pages 2 0 R >>');
  writePdfObject(objects, 3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  pages.forEach((lines, index) => {
    const pageId = 4 + index * 2;
    const contentId = pageId + 1;
    pageRefs.push(`${pageId} 0 R`);
    const content = [
      'BT',
      '/F1 11 Tf',
      '72 760 Td',
      '15 TL',
      ...lines.map(line => `(${escapePdfText(line)}) Tj T*`),
      'ET'
    ].join('\n');
    writePdfObject(objects, pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`);
    writePdfObject(objects, contentId, `<< /Length ${Buffer.byteLength(content, 'utf8')} >>\nstream\n${content}\nendstream`);
  });

  writePdfObject(objects, 2, `<< /Type /Pages /Kids [${pageRefs.join(' ')}] /Count ${pageRefs.length} >>`);

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(pdf, 'utf8');
    pdf += objects[id];
  }
  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length}\n`;
  pdf += '0000000000 65535 f \n';
  for (let id = 1; id < objects.length; id++) {
    pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return pdf;
}

async function withTempPdf(name, pages, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-pdf-test-'));
  const pdfPath = path.join(dir, name);
  await fs.writeFile(pdfPath, buildSimplePdf(pages));
  try {
    return await fn(pdfPath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

section('PDF Normalization');

{
  const result = normalizePdfText('Page 12 of 300\nThe word was hyphen-\nated.\n\n- 13 -\nNext line.');
  assert(!/Page 12/.test(result.text), 'removes Page X of Y lines');
  assert(!/- 13 -/.test(result.text), 'removes decorated page numbers');
  assert(/hyphenated/.test(result.text), 'joins hyphenated line wraps');
}

{
  const normalized = normalizePdfPages([
    { pageNumber: 1, text: 'The Book Title\n\nChapter One\nFirst body paragraph.' },
    { pageNumber: 2, text: 'The Book Title\n\nMore body.' },
    { pageNumber: 3, text: 'The Book Title\n\nMore body.' },
    { pageNumber: 4, text: 'The Book Title\n\nMore body.' }
  ]);
  const text = normalized.pages.map(page => page.text).join('\n');
  assert(!/The Book Title/.test(text), 'removes repeated running headers');
}

section('PDF Chapter Detection');

{
  const text = [
    'Title Page',
    '',
    'Chapter One',
    'This is a substantial opening paragraph. '.repeat(30),
    '',
    'Chapter Two: The Road',
    'This is a substantial second chapter paragraph. '.repeat(30)
  ].join('\n');
  const chapters = __test.buildTextChapters(text, { sourceLabel: 'Sample' });
  assert(chapters.length === 2, 'detects prose chapter headings');
  assert(chapters[0].title === 'Chapter One', 'keeps normalized chapter title');
  assert(chapters[1].title === 'Chapter Two: The Road', 'keeps chapter subtitle');
}

{
  const chapters = __test.buildTextChapters('No headings here. '.repeat(200), { sourceLabel: 'Sample PDF' });
  assert(chapters.length === 1, 'falls back to one content section without false headings');
  assert(chapters[0].title === 'Sample PDF', 'uses source label for fallback title');
}

section('PDF Candidate Scoring');

{
  const redoArgs = __test.buildPdfOcrArgs({
    inputPath: 'in.pdf',
    outputPath: 'out.pdf',
    mode: 'redo-ocr',
    language: 'eng',
    jobs: 2
  });
  const skipArgs = __test.buildPdfOcrArgs({
    inputPath: 'in.pdf',
    outputPath: 'out.pdf',
    mode: 'skip-text',
    language: 'eng',
    jobs: 2
  });
  assert(redoArgs.includes('--redo-ocr'), 'builds redo OCR mode arguments');
  assert(!redoArgs.includes('--deskew'), 'omits deskew for OCRmyPDF redo mode');
  assert(skipArgs.includes('--deskew'), 'keeps deskew for non-redo OCR modes');

  const bboxPages = __test.extractPagesFromBboxLayout(`
    <doc>
      <page width="612" height="792">
        <flow><block><line>
          <word xMin="1" yMin="1" xMax="2" yMax="2">Chapter</word>
          <word xMin="3" yMin="1" xMax="4" yMax="2">One</word>
        </line></block></flow>
      </page>
    </doc>
  `);
  assert(bboxPages.length === 1, 'parses bbox-layout pages');
  assert(bboxPages[0].text === 'Chapter One', 'parses bbox-layout words into reading lines');

  const good = {
    ok: true,
    mode: 'pdftotext-layout-normalized',
    stats: { pageCount: 100 },
    chapters: [
      { title: 'Chapter 1', text: 'Readable prose with enough words. '.repeat(2000) },
      { title: 'Chapter 2', text: 'More readable prose with enough words. '.repeat(2000) }
    ]
  };
  const scanned = {
    ok: true,
    mode: 'pdf-parse-normalized',
    stats: { pageCount: 100 },
    chapters: [{ title: 'Scanned', text: 'tiny text '.repeat(100) }]
  };
  const selected = __test.selectPdfExtractionCandidate([scanned, good]).selected;
  assert(selected.mode === 'pdftotext-layout-normalized', 'selects the stronger extraction candidate');
  assert(__test.scorePdfExtractionCandidate(scanned).warnings.some(w => /text per page|low text length/.test(w)), 'flags likely scanned or low-text PDFs');
  const scannedQuality = __test.scorePdfExtractionCandidate(scanned);
  const scannedStatus = __test.classifyPdfExtractionStatus({ ...scanned, quality: scannedQuality });
  assert(scannedStatus.status === 'ocr-required', 'classifies multi-page low-text PDFs as OCR-required');
}

async function runFixtureTests() {
  section('Generated PDF Extraction');

  await withTempPdf('readable.pdf', [
    ['Reader Header', 'Page 1 of 6', '', 'Chapter One', ...repeatedLines('This is readable book prose for extraction and narration.', 12)],
    ['Reader Header', 'Page 2 of 6', '', ...repeatedLines('More readable book prose follows in natural order.', 12)],
    ['Reader Header', 'Page 3 of 6', '', 'Chapter Two: The Road', ...repeatedLines('This is the second chapter with enough prose to detect.', 12)],
    ['Reader Header', 'Page 4 of 6', '', ...repeatedLines('The second chapter continues with ordinary sentences.', 12)],
    ['Reader Header', 'Page 5 of 6', '', ...repeatedLines('A closing page keeps the text density above scanned thresholds.', 12)],
    ['Reader Header', 'Page 6 of 6', '', ...repeatedLines('The final page remains readable and extractable.', 12)]
  ], async pdfPath => {
    const chapters = await extractPdfChapters(pdfPath, { warn: false });
    const extraction = chapters[0]?.pdfExtraction;
    assert(chapters.length >= 2, 'extracts generated readable PDF into detected chapters');
    assert(extraction && ['ready', 'review-needed'].includes(extraction.status), 'records ready/review status for readable PDF');
    assert(extraction && extraction.pageCount === 6, 'records pdfinfo page count');
    assert(extraction && extraction.candidates.some(candidate => candidate.name === 'pdftotext-bbox-layout-normalized'), 'reports bbox-layout extraction candidate');
  });

  await withTempPdf('scanned-like.pdf', [
    ['scan'],
    ['scan'],
    ['scan'],
    ['scan'],
    ['scan'],
    ['scan']
  ], async pdfPath => {
    let error = null;
    try {
      await extractPdfChapters(pdfPath, { warn: false });
    } catch (err) {
      error = err;
    }
    assert(error && error.pdfExtraction?.status === 'ocr-required', 'rejects generated low-text PDF as OCR-required');
    assert(error && error.pdfExtraction?.ocr?.attempted === false, 'records OCR-disabled diagnostic by default');
  });

  await withTempPdf('scanned-retry.pdf', [
    ['scan'],
    ['scan'],
    ['scan'],
    ['scan'],
    ['scan'],
    ['scan']
  ], async pdfPath => {
    const chapters = await extractPdfChapters(pdfPath, {
      warn: false,
      ocr: true,
      ocrRunner: async ({ outputPath }) => {
        await fs.writeFile(outputPath, buildSimplePdf([
          ['Recovered Header', 'Page 1 of 6', '', 'Chapter One', ...repeatedLines('Recovered OCR prose is readable and ordered for narration.', 30)],
          ['Recovered Header', 'Page 2 of 6', '', ...repeatedLines('The first chapter continues with enough extracted words per page.', 30)],
          ['Recovered Header', 'Page 3 of 6', '', 'Chapter Two', ...repeatedLines('A second chapter appears after OCR and should be detected.', 30)],
          ['Recovered Header', 'Page 4 of 6', '', ...repeatedLines('More recovered text keeps density well above scanned thresholds.', 30)],
          ['Recovered Header', 'Page 5 of 6', '', ...repeatedLines('The OCR retry feeds the same normalization and scoring pipeline.', 30)],
          ['Recovered Header', 'Page 6 of 6', '', ...repeatedLines('The final recovered page remains clean and useful for audio.', 30)]
        ]));
        return { outputPath, engine: 'fake-ocr' };
      }
    });
    const extraction = chapters[0]?.pdfExtraction;
    assert(chapters.length >= 2, 'OCR retry re-extracts readable PDF into chapters');
    assert(extraction && ['ready', 'review-needed'].includes(extraction.status), 'OCR retry records usable extraction status');
    assert(extraction?.ocr?.attempted === true, 'records OCR retry attempt');
    assert(extraction?.ocr?.used === true, 'records OCR output usage');
    assert(extraction?.ocr?.engine === 'fake-ocr', 'records OCR engine diagnostics');
  });
}

runFixtureTests()
  .then(() => {
    console.log(`\nPDF extraction tests: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  })
  .catch(err => {
    failed++;
    console.error(`  FAIL fixture test crashed: ${err.message}`);
    console.log(`\nPDF extraction tests: ${passed} passed, ${failed} failed`);
    process.exit(1);
  });
