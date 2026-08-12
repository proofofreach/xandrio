const {
  normalizePdfText,
  normalizePdfPages
} = require('../lib/pdf-text-normalizer');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const {
  extractPdfChapters,
  extractPdfMetadata,
  reprocessPdfSourceDocument,
  __test
} = require('../lib/pdf-extraction');

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

function buildSimplePdf(pages, options = {}) {
  const objects = [];
  const pageRefs = [];
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
  const outlines = Array.isArray(options.outline) ? options.outline : [];
  if (outlines.length > 0) {
    const outlineRootId = 4 + pages.length * 2;
    const itemIds = outlines.map((_, index) => outlineRootId + 1 + index);
    writePdfObject(
      objects,
      outlineRootId,
      `<< /Type /Outlines /First ${itemIds[0]} 0 R /Last ${itemIds[itemIds.length - 1]} 0 R /Count ${itemIds.length} >>`
    );
    outlines.forEach((item, index) => {
      const pageIndex = Math.max(0, Math.min(pages.length - 1, Number(item.pageNumber || 1) - 1));
      const pageId = 4 + pageIndex * 2;
      const links = [
        index > 0 ? `/Prev ${itemIds[index - 1]} 0 R` : '',
        index + 1 < itemIds.length ? `/Next ${itemIds[index + 1]} 0 R` : ''
      ].filter(Boolean).join(' ');
      writePdfObject(
        objects,
        itemIds[index],
        `<< /Title (${escapePdfText(item.title)}) /Parent ${outlineRootId} 0 R ${links} /Dest [${pageId} 0 R /Fit] >>`
      );
    });
    writePdfObject(objects, 1, `<< /Type /Catalog /Pages 2 0 R /Outlines ${outlineRootId} 0 R >>`);
  } else {
    writePdfObject(objects, 1, '<< /Type /Catalog /Pages 2 0 R >>');
  }

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

async function withTempPdf(name, pages, fn, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-pdf-test-'));
  const pdfPath = path.join(dir, name);
  await fs.writeFile(pdfPath, buildSimplePdf(pages, options));
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
  assert(bboxPages[0].width === 612 && bboxPages[0].lines[0].xMin === 1,
    'preserves bbox page and line geometry for heading analysis');

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

  const grouped = {
    ok: true,
    mode: 'pdftotext-layout-normalized',
    stats: { pageCount: 100 },
    chapters: Array.from({ length: 20 }, (_, index) => ({
      title: `Pages ${index * 5 + 1}-${index * 5 + 5}`,
      text: 'Readable prose with enough words. '.repeat(1200)
    })),
    structure: { mode: 'page-groups', confidence: 0 },
    chapterValidation: { valid: false, reason: 'not enough detected sections' }
  };
  grouped.quality = __test.scorePdfExtractionCandidate(grouped);
  assert(__test.classifyPdfExtractionStatus(grouped).status === 'review-needed' &&
    grouped.quality.warnings.some(warning => /page groups/.test(warning)),
  'marks page-group fallback as explicit low-confidence review work');
}

async function runFixtureTests() {
  section('Generated PDF Extraction');

  await withTempPdf('title-page.pdf', [
    [
      'Ready, Fire, Aim',
      '',
      'Zero to $100 Million',
      'in No Time Flat',
      '',
      'Michael Masterson'
    ]
  ], async pdfPath => {
    const metadata = await extractPdfMetadata(pdfPath);
    assert(metadata.title === 'Ready, Fire, Aim: Zero to $100 Million in No Time Flat',
      'recovers a complete wrapped title from the title page');
    assert(metadata.author === 'Michael Masterson',
      'recovers the author from the title page');
  });

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

  await withTempPdf('toc-structured.pdf', [
    ['A Practical Book', '', 'Ada Author'],
    [
      'Contents',
      '',
      'PART ONE Learning the Work 1',
      '',
      'CHAPTER 1 First Steps 2',
      '',
      'CHAPTER 2 Going Further 5',
      '',
      'Afterword 8',
      '',
      'Notes 9'
    ],
    ['PART ONE', 'LEARNING THE WORK'],
    ['CHAPTER ONE', 'FIRST STEPS', '', ...repeatedLines('The first chapter contains substantial readable prose for narration.', 22)],
    repeatedLines('The first chapter continues with useful examples and explanations.', 24),
    repeatedLines('The first chapter closes with a final practical exercise.', 24),
    ['CHAPTER TWO', 'GOING FURTHER', '', ...repeatedLines('The second chapter contains substantial readable prose for narration.', 22)],
    repeatedLines('The second chapter continues with useful examples and explanations.', 24),
    repeatedLines('The second chapter closes with a final practical exercise.', 24),
    ['AFTERWORD', '', ...repeatedLines('The afterword provides a concise conclusion to the complete book.', 20)],
    ['NOTES', ...repeatedLines('A source note that should not become narrated chapter content.', 12)]
  ], async pdfPath => {
    const chapters = await extractPdfChapters(pdfPath, { warn: false });
    assert(chapters.length === 3,
      'uses authored TOC boundaries instead of arbitrary page groups');
    assert(chapters.map(chapter => chapter.title).join('|') ===
      'Chapter 1: First Steps|Chapter 2: Going Further|Afterword',
    'uses TOC chapter names and skips part and notes pages');
    assert(chapters[0].partTitle === 'Part One: Learning the Work' &&
      chapters[1].partTitle === 'Part One: Learning the Work',
    'preserves part hierarchy as chapter grouping metadata');
    assert(chapters[0].pdfExtraction?.structure?.mode === 'toc',
      'reports TOC-based structure recovery');
    assert(chapters.sourceDocument?._pdfStructureVersion >= 2 &&
      chapters.sourceDocument.pages.length === 11,
    'returns versioned per-page source data for future reprocessing');
    const reprocessed = await reprocessPdfSourceDocument(chapters.sourceDocument, {
      sourceLabel: 'Reprocessed book'
    });
    assert(reprocessed.map(chapter => chapter.title).join('|') ===
      chapters.map(chapter => chapter.title).join('|'),
    'reprocesses authored chapters from persisted page data without the original PDF');
    let lowQualityReprocessError;
    try {
      await reprocessPdfSourceDocument({
        _pdfStructureVersion: 2,
        pageCount: 6,
        pages: Array.from({ length: 6 }, (_, index) => ({
          pageNumber: index + 1,
          text: 'x'
        }))
      });
    } catch (error) {
      lowQualityReprocessError = error;
    }
    assert(lowQualityReprocessError?.code === 'PDF_OCR_REQUIRED',
      'refuses to overwrite an artifact when persisted PDF text is unusable');
  });

  await withTempPdf('outline-structured.pdf', [
    ['An Outlined Book', '', 'Ada Author'],
    ['INTRODUCTION', ...repeatedLines('The introduction contains substantial readable prose for narration.', 20)],
    ['PART ONE', 'LEARNING THE WORK'],
    ['CHAPTER ONE', 'FIRST STEPS', ...repeatedLines('The first chapter contains substantial readable prose for narration.', 20)],
    repeatedLines('The first chapter continues with practical examples.', 24),
    repeatedLines('The first chapter closes with a useful exercise.', 24),
    ['CHAPTER TWO', 'GOING FURTHER', ...repeatedLines('The second chapter contains substantial readable prose for narration.', 20)],
    repeatedLines('The second chapter continues with practical examples.', 24),
    repeatedLines('The second chapter closes with a useful exercise.', 24),
    ['NOTES', ...repeatedLines('A source note that should not be narrated.', 12)]
  ], async pdfPath => {
    const chapters = await extractPdfChapters(pdfPath, { warn: false });
    assert(chapters.map(chapter => chapter.title).join('|') ===
      'Introduction|Chapter 1: First Steps|Chapter 2: Going Further',
    'uses semantic PDF bookmarks before inferred headings');
    assert(chapters[0].pdfExtraction?.structure?.mode === 'outline',
      'reports bookmark-based structure recovery');
  }, {
    outline: [
      { title: 'Introduction', pageNumber: 2 },
      { title: 'Part One: Learning the Work', pageNumber: 3 },
      { title: 'Chapter 1: First Steps', pageNumber: 4 },
      { title: 'Chapter 2: Going Further', pageNumber: 7 },
      { title: 'Notes', pageNumber: 10 }
    ]
  });

  await withTempPdf('numeric-headings.pdf', [
    ['A Numbered Book', '', 'Ada Author'],
    ['1', 'FIRST STEPS', '', ...repeatedLines('The first numbered chapter contains readable narration.', 24)],
    repeatedLines('The first numbered chapter continues with practical details.', 24),
    repeatedLines('The first numbered chapter ends with a useful exercise.', 24),
    ['2', 'GOING FURTHER', '', ...repeatedLines('The second numbered chapter contains readable narration.', 24)],
    repeatedLines('The second numbered chapter continues with practical details.', 24),
    repeatedLines('The second numbered chapter ends with a useful exercise.', 24)
  ], async pdfPath => {
    const chapters = await extractPdfChapters(pdfPath, { warn: false });
    assert(chapters.map(chapter => chapter.title).join('|') ===
      'Chapter 1: First Steps|Chapter 2: Going Further',
    'detects numeric multiline chapter headings before text normalization');
    assert(chapters[0].pdfExtraction?.structure?.mode === 'detected-headings',
      'reports positioned heading structure recovery');
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

  await withTempPdf('short-readable-low-confidence.pdf', [
    ['Short Book', ...repeatedLines('This readable sentence is preserved for narration.', 20)],
    [...repeatedLines('The second page continues the meaningful short work.', 20)]
  ], async pdfPath => {
    const chapters = await extractPdfChapters(pdfPath, { warn: false });
    assert(chapters[0]?.pdfExtraction?.status === 'failed' && chapters[0].text.length > 500,
      'returns meaningful PDF text even when confidence scoring fails');
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
