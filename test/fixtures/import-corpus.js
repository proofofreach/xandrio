const { DIAGNOSTIC_CODES } = require('../../lib/extraction-result');

function prose(label, repetitions = 40) {
  return `${label} contains complete synthetic sentences for audiobook characterization. `.repeat(repetitions);
}

function corpusCase(value) {
  return Object.freeze({
    ...value,
    sourcePayload: JSON.stringify({
      sourceFormat: value.sourceFormat,
      chapters: value.chapters,
      diagnostics: value.diagnostics || []
    })
  });
}

module.exports = Object.freeze([
  corpusCase({
    id: 'epub-authored-structure',
    sourceFormat: 'epub',
    chapters: [1, 2, 3].map((number, index) => ({
      index,
      originalIndex: index,
      title: `Chapter ${number}`,
      type: 'chapter',
      fromToc: true,
      sourceHref: `chapter-${number}.xhtml`,
      text: prose(`Authored EPUB chapter ${number}`),
      estimatedDuration: 180
    })),
    expected: {
      importable: true,
      diagnosticCodes: [],
      importDiagnosticCodes: [DIAGNOSTIC_CODES.SHORT_CONTENT],
      mutationCodes: [],
      chapterCount: 3,
      sourceHash: 'f6249b7ba3dca86bcf58db853e4c4da1ed983c9bcd79f17bbb56d65302d3912e',
      normalizedHash: 'd68401bc3ab7a5d9e4cf1b30fbde05afec8453ab8d2fea7dc6f9780421204b5d',
      structureKey: 'v1-7bea4a9d800aaab1c2df'
    }
  }),
  corpusCase({
    id: 'pdf-low-confidence-readable',
    sourceFormat: 'pdf',
    chapters: [
      {
        index: 0,
        originalIndex: 0,
        title: 'Opening',
        type: 'content',
        text: prose('Readable PDF opening', 55),
        estimatedDuration: 220,
        normalization: {
          whitespaceFixes: 1,
          paragraphLineJoins: 3,
          pageNumberLinesRemoved: 2,
          hyphenJoins: 1,
          ligatureFixes: 0,
          spacedCapsFixes: 0,
          repeatedHeaderFooterLinesRemoved: 4,
          ocrRepairsApplied: 0
        },
        pdfExtraction: {
          status: 'review-needed',
          score: 42,
          structure: { mode: 'page-groups', confidence: 0 }
        }
      },
      {
        index: 1,
        originalIndex: 1,
        title: 'Continuation',
        type: 'content',
        text: prose('Readable PDF continuation', 55),
        estimatedDuration: 220
      }
    ],
    expected: {
      importable: true,
      diagnosticCodes: [DIAGNOSTIC_CODES.STRUCTURE_LOW_CONFIDENCE],
      importDiagnosticCodes: [
        DIAGNOSTIC_CODES.STRUCTURE_LOW_CONFIDENCE,
        DIAGNOSTIC_CODES.SHORT_CONTENT
      ],
      mutationCodes: [
        'mutation.whitespace-normalization',
        'mutation.semantic-page-marker-removal',
        'mutation.line-wrap-dehyphenation',
        'mutation.repeated-header-footer-removal'
      ],
      chapterCount: 2,
      sourceHash: '3212ef4c63ea29b0fc08742438766e9946a1e24431f5a1b0c2b9c205e1da32b7',
      normalizedHash: '13b4e3a668fae5aea380db2a4ca5a876d10b883502acbdcd0cdba41a12e89c21',
      structureKey: 'v1-728266b6f9a84acd1ed4'
    }
  }),
  corpusCase({
    id: 'kindle-unknown-structure-readable',
    sourceFormat: 'azw3',
    chapters: [{
      index: 0,
      originalIndex: 0,
      title: 'Content',
      type: 'content',
      text: prose('Readable Kindle content', 85),
      estimatedDuration: 300
    }],
    diagnostics: [{
      code: DIAGNOSTIC_CODES.STRUCTURE_UNKNOWN,
      severity: 'warning',
      category: 'structure-confidence',
      recoverability: 'automatic'
    }],
    expected: {
      importable: true,
      diagnosticCodes: [DIAGNOSTIC_CODES.STRUCTURE_UNKNOWN],
      importDiagnosticCodes: [
        DIAGNOSTIC_CODES.STRUCTURE_UNKNOWN,
        DIAGNOSTIC_CODES.SHORT_CONTENT
      ],
      mutationCodes: [],
      chapterCount: 1,
      sourceHash: '8060ec3b21d62828217bd2790202624e4a633357fe21115e44d090b4e4fe4ccf',
      normalizedHash: '613cb9e0314322df7fc302dd1fd9906429397bfa3f97c34ab744166686307041',
      structureKey: 'v1-a02a98e199cf1b95f56f'
    }
  }),
  corpusCase({
    id: 'epub-oversized-narration',
    sourceFormat: 'epub',
    splitOversized: true,
    chapters: [{
      index: 0,
      originalIndex: 0,
      title: 'Continuous Narrative',
      type: 'content',
      text: Array.from(
        { length: 1900 },
        (_value, index) => `Long unstructured EPUB narrative passage ${index + 1} remains readable and continuous.`
      ).join(' '),
      estimatedDuration: 9000
    }],
    expected: {
      importable: true,
      diagnosticCodes: [],
      importDiagnosticCodes: [DIAGNOSTIC_CODES.SPARSE_SECTIONS],
      mutationCodes: [],
      chapterCount: 2,
      sourceHash: '35657d10b931b62ab8f3de8205918b3ce272a98970db56eb50a322642445814b',
      normalizedHash: '86314caf142f3199954b284e90457cfa1ac801cb88168de7f036de2fb91eb09d',
      structureKey: 'v1-71f000b387ae76f0e10d'
    }
  }),
  corpusCase({
    id: 'epub-decode-loss-readable',
    sourceFormat: 'epub',
    chapters: [1, 2, 3, 4].map((number, index) => ({
      index,
      originalIndex: index,
      title: `Chapter ${number}`,
      type: 'chapter',
      fromToc: true,
      sourceHref: `chapter-${number}.xhtml`,
      text: `${prose(`Decode-loss EPUB chapter ${number}`, 24)}Damaged markers: ${'\uFFFD'.repeat(8)}`,
      estimatedDuration: 180
    })),
    expected: {
      importable: true,
      diagnosticCodes: [DIAGNOSTIC_CODES.REPLACEMENT_CHARACTERS],
      importDiagnosticCodes: [
        DIAGNOSTIC_CODES.REPLACEMENT_CHARACTERS,
        DIAGNOSTIC_CODES.SHORT_CONTENT
      ],
      mutationCodes: [],
      chapterCount: 4,
      sourceDefectCount: 32,
      sourceHash: '1b54df53b9a4555ffa7a2847fec9d20154fa4cd86bc25fba7f7cd17ff4ca924e',
      normalizedHash: '98ce1aa0017da6e8dafe1222af2ebbaaafdd216d2eb402fc160a1cd6f078c3ec',
      structureKey: 'v1-c8033f132ee227551508'
    }
  }),
  corpusCase({
    id: 'pdf-ocr-required-empty',
    sourceFormat: 'pdf',
    chapters: [{
      index: 0,
      originalIndex: 0,
      title: 'Scanned Pages',
      type: 'content',
      text: '',
      pdfExtraction: { status: 'ocr-required', score: 0 }
    }],
    expected: {
      importable: false,
      diagnosticCodes: [DIAGNOSTIC_CODES.OCR_REQUIRED],
      importDiagnosticCodes: [
        DIAGNOSTIC_CODES.OCR_REQUIRED,
        DIAGNOSTIC_CODES.SPARSE_SECTIONS
      ],
      mutationCodes: [],
      chapterCount: 1,
      sourceHash: '5bd478cebdb91b9ff636999809d0a9ca1a9059735d9e9d20c1f4837a735458ee',
      normalizedHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      structureKey: 'v1-1ae95116ed7c60e36665'
    }
  }),
  corpusCase({
    id: 'kindle-divider-collection',
    sourceFormat: 'mobi',
    normalizeSequence: true,
    chapters: [
      {
        index: 0,
        originalIndex: 0,
        title: 'FROM',
        type: 'divider',
        tocTitleSource: 'href',
        text: 'FROM\n\nThe First Volume\n(1961)',
        estimatedDuration: 2
      },
      {
        index: 1,
        originalIndex: 1,
        title: 'Chapter 2',
        type: 'chapter',
        tocTitleSource: 'href',
        text: prose('Collected excerpt one', 55),
        estimatedDuration: 220
      },
      {
        index: 2,
        originalIndex: 2,
        title: 'FROM',
        type: 'divider',
        tocTitleSource: 'href',
        text: 'FROM\n\nThe Second Volume:\n\nAn Honest Sequel\n(1972)',
        estimatedDuration: 3
      },
      {
        index: 3,
        originalIndex: 3,
        title: 'Chapter 3',
        type: 'chapter',
        tocTitleSource: 'href',
        text: prose('Collected excerpt two', 55),
        estimatedDuration: 220
      },
      {
        index: 4,
        originalIndex: 4,
        title: 'A Named Essay',
        type: 'content',
        tocTitleSource: 'href',
        text: prose('Collected essay', 55),
        estimatedDuration: 220
      }
    ],
    expected: {
      importable: true,
      diagnosticCodes: [],
      importDiagnosticCodes: [DIAGNOSTIC_CODES.SHORT_CONTENT],
      mutationCodes: [],
      chapterCount: 3,
      sourceHash: '2d80d4a60649c01369130adce53b6da59e1543b07da6b96b2177d18a993788f4',
      normalizedHash: 'ff33626bd901f153486df2de704252538154da8982ad913dfe4ef452216087de',
      structureKey: 'v1-874c0a1a812ac08447b8'
    }
  }),
  corpusCase({
    id: 'kindle-drm-protected',
    sourceFormat: 'azw3',
    chapters: [],
    diagnostics: [{
      code: DIAGNOSTIC_CODES.DRM_PROTECTED,
      severity: 'error',
      category: 'invalid-input',
      recoverability: 'none'
    }],
    expected: {
      importable: false,
      diagnosticCodes: [DIAGNOSTIC_CODES.DRM_PROTECTED],
      importDiagnosticCodes: [DIAGNOSTIC_CODES.DRM_PROTECTED],
      mutationCodes: [],
      chapterCount: 0,
      sourceHash: '270ba64f9fd4dca05f655ba70d9add47a32091ec81d4feac7b743f90177869dd',
      normalizedHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      structureKey: null
    }
  })
]);
