const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const {
  extractKindleChapters,
  extractKindleMetadata,
  extractKindleCover,
  __test
} = require('../lib/kindle-extraction');
const { assessExtractedContent } = require('../lib/import-validation');

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

function prose(seed, sentences = 260) {
  const subjects = ['library', 'harbor', 'garden', 'station', 'orchard', 'workshop', 'river', 'market'];
  const verbs = ['opened', 'carried', 'remembered', 'followed', 'measured', 'gathered', 'noticed', 'described'];
  const objects = ['a quiet lantern', 'the folded letter', 'an old promise', 'the morning path', 'a silver compass', 'the warm bread', 'a patient song', 'the hidden doorway'];
  const clauses = ['while the rain softened the street', 'before the bells answered noon', 'as the room filled with sunlight', 'because every voice had become familiar'];
  return Array.from({ length: sentences }, (_, index) => {
    const offset = seed + index;
    return `The ${subjects[offset % subjects.length]} ${verbs[(offset + 2) % verbs.length]} ${objects[(offset + 4) % objects.length]} ${clauses[(offset + 6) % clauses.length]}.`;
  }).join(' ');
}

function chapterHtml(title, seed, sentences = 260) {
  return `<html><body><h1>${title}</h1><p>${prose(seed, sentences)}</p></body></html>`;
}

function jpegFixture() {
  const image = Buffer.alloc(1400, 8);
  image[0] = 0xff;
  image[1] = 0xd8;
  image[2] = 0xff;
  image[3] = 0xe0;
  image.writeUInt16BE(16, 4);
  image[20] = 0xff;
  image[21] = 0xc0;
  image.writeUInt16BE(17, 22);
  image[24] = 8;
  image.writeUInt16BE(500, 25);
  image.writeUInt16BE(333, 27);
  image[29] = 3;
  image[image.length - 2] = 0xff;
  image[image.length - 1] = 0xd9;
  return image;
}

function makeParser(config = {}) {
  const resolveMap = config.resolveMap || {};
  const chapters = config.chapters || {};
  return {
    getSpine: () => config.spine || [],
    getToc: () => config.toc || [],
    getGuide: () => config.guide || [],
    getMetadata: () => config.metadata || {},
    getCoverImage: () => config.coverPath || '',
    resolveHref: href => resolveMap[href] || undefined,
    loadChapter: id => {
      const value = chapters[id];
      if (value instanceof Error) throw value;
      if (value === undefined) return undefined;
      if (typeof value === 'string') return { html: value, css: [] };
      return value;
    },
    destroy: () => {
      if (typeof config.onDestroy === 'function') config.onDestroy();
    }
  };
}

function parserFactories({ mobi, kf8 }) {
  return {
    initMobiFile: async () => {
      if (mobi instanceof Error) throw mobi;
      return makeParser(mobi);
    },
    initKf8File: async () => {
      if (kf8 instanceof Error) throw kf8;
      return makeParser(kf8);
    }
  };
}

function goodKindleConfig(overrides = {}) {
  return {
    spine: [
      { id: 'c1', text: '' },
      { id: 'c2', text: '' },
      { id: 'c3', text: '' }
    ],
    toc: [
      { label: 'Chapter One', href: 'text/c1.html' },
      { label: 'Chapter Two', href: 'text/c2.html' },
      { label: 'Chapter Three', href: 'text/c3.html' }
    ],
    resolveMap: {
      'text/c1.html': { id: 'c1', selector: '' },
      'text/c2.html': { id: 'c2', selector: '' },
      'text/c3.html': { id: 'c3', selector: '' }
    },
    chapters: {
      c1: chapterHtml('Wrong Inline Title', 1),
      c2: chapterHtml('Wrong Inline Title', 2),
      c3: chapterHtml('Wrong Inline Title', 3)
    },
    metadata: {
      title: 'Test Kindle Book',
      author: ['Author Name'],
      language: ['en'],
      publisher: 'Publisher'
    },
    ...overrides
  };
}

section('Kindle Extraction');

(async () => {
  {
    const chapters = await extractKindleChapters('/tmp/book.mobi', {
      format: 'mobi',
      warn: false,
      container: { available: true, extension: 'mobi', likelyMobi7: true },
      parserFactories: parserFactories({
        mobi: goodKindleConfig(),
        kf8: new Error('not a KF8 file')
      })
    });
    const report = chapters[0]?.kindleExtraction;
    assert(chapters.length === 3, 'extracts Kindle spine chapters');
    assert(chapters[0].title === 'Chapter One', 'maps TOC hrefs to spine titles');
    assert(report?.status === 'ready', 'records ready Kindle extraction status');
    assert(report?.selected === 'mobi-primary', 'selects MOBI primary parser for MOBI files');
    assert(report?.candidates.some(candidate => candidate.name === 'kf8-fallback'), 'reports fallback parser candidate');
  }

  {
    const config = goodKindleConfig({
      spine: [
        { id: 'title-page' },
        { id: 'copyright' },
        { id: 'dedication' },
        { id: 'contents' },
        { id: 'c1' },
        { id: 'c2' },
        { id: 'c3' },
        { id: 'praise' }
      ],
      toc: [
        { label: 'Foreword', href: 'text/c1.html' },
        { label: 'Introduction', href: 'text/c2.html' },
        { label: 'Major Disadvantages', href: 'text/c3.html' }
      ],
      resolveMap: {
        'text/c1.html': { id: 'c1', selector: '' },
        'text/c2.html': { id: 'c2', selector: '' },
        'text/c3.html': { id: 'c3', selector: '' }
      },
      chapters: {
        'title-page': '<html><body><p>Revelations of Christ</p><p>Proclaimed by Paramhansa Yogananda</p><p>Crystal Clarity Publishers</p></body></html>',
        copyright: '<html><body><p>Copyright 2010 by Hansa Trust. All rights reserved.</p><p>ISBN 978-1-56589-240-8</p></body></html>',
        dedication: '<html><body><p>Dedicated to those sincere Christians whose faith has been shaken.</p></body></html>',
        contents: '<html><body><p>Foreword</p><p>Introduction</p><p>1. Major Disadvantages</p><p>2. A Name for Truth</p><p>3. The Purpose of Religion</p></body></html>',
        c1: chapterHtml('Foreword', 1),
        c2: chapterHtml('Introduction', 2),
        c3: chapterHtml('Major Disadvantages', 3),
        praise: '<html><body><h1>Praise for Revelations of Christ</h1><p>Endorsement text.</p></body></html>'
      }
    });
    const chapters = await extractKindleChapters('/tmp/shifted-toc.azw3', {
      format: 'azw3',
      warn: false,
      container: { available: true, extension: 'azw3', likelyKf8: true },
      parserFactories: parserFactories({ kf8: config, mobi: new Error('not MOBI') })
    });
    const report = chapters[0]?.kindleExtraction;
    assert(chapters.slice(0, 4).map(chapter => chapter.title).join('|') === 'Title Page|Copyright|Dedication|Contents',
      'does not shift partial TOC labels onto unmatched leading spine items');
    assert(chapters.slice(4, 7).map(chapter => chapter.title).join('|') === 'Foreword|Introduction|Major Disadvantages',
      'keeps href-matched TOC labels on their actual Kindle spine items');
    assert(chapters[7].type === 'backmatter', 'classifies unmatched trailing Kindle spine items as back matter');
    assert(report?.candidates[0]?.stats?.positionalTocCount === 0,
      'reports that a partial href-mapped TOC did not use positional fallback');
    assert(report?.candidates[0]?.warnings?.some(warning => /repaired structural section labels/.test(warning)),
      'validation reports repaired Kindle section labels instead of awarding a silent perfect score');
  }

  {
    const giantText = prose(30, 2600);
    const config = goodKindleConfig({
      chapters: {
        c1: `<html><body><p>${giantText}</p></body></html>`,
        c2: chapterHtml('Afterword', 2),
        c3: chapterHtml('Notes', 3)
      }
    });
    const chapters = await extractKindleChapters('/tmp/giant-section.azw3', {
      format: 'azw3',
      warn: false,
      container: { available: true, extension: 'azw3', likelyKf8: true },
      parserFactories: parserFactories({
        kf8: config,
        mobi: new Error('not MOBI')
      })
    });
    const maxChars = Math.max(...chapters.map(chapter => chapter.text.length));
    const extractedGiantText = chapters
      .filter(chapter => chapter.sourceSpineId === 'c1')
      .map(chapter => chapter.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    assert(maxChars <= 100000, 'splits a valid 239K-style Kindle spine section into usable chapters');
    assert(extractedGiantText === giantText.replace(/\s+/g, ' ').trim(), 'oversized-section repair preserves all prose in order');
  }

  {
    const config = goodKindleConfig({
      toc: [
        { label: '1 Origins I: A. K. Sarvis, M.D.', href: 'text/c1.html' },
        { label: '2 Origins II: George W. Hayduke', href: 'text/c2.html' },
        { label: '3 Origins III: Seldom Seen Smith', href: 'text/c3.html' }
      ],
      chapters: {
        c1: chapterHtml('Copyright', 1, 2),
        c2: chapterHtml('Historical Note', 2, 2),
        c3: chapterHtml('In Memoriam', 3, 2)
      }
    });
    const chapters = await extractKindleChapters('/tmp/book.mobi', {
      format: 'mobi',
      warn: false,
      container: { available: true, extension: 'mobi', likelyMobi7: true },
      parserFactories: parserFactories({
        mobi: config,
        kf8: new Error('not a KF8 file')
      })
    });
    assert(chapters[1].type === 'frontmatter', 'frontmatter text is not promoted by a shifted numbered TOC title');
  }

  {
    const chapters = await extractKindleChapters('/tmp/book.mobi', 'mobi', {
      warn: false,
      container: { available: true, extension: 'mobi', likelyMobi7: true },
      parserFactories: parserFactories({
        mobi: goodKindleConfig(),
        kf8: new Error('not a KF8 file')
      })
    });
    assert(chapters[0]?.kindleExtraction?.selected === 'mobi-primary', 'supports legacy positional Kindle extraction call shape');
  }

  {
    const chapters = await extractKindleChapters('/tmp/book.mobi', {
      format: 'mobi',
      warn: false,
      container: { available: true, extension: 'mobi', likelyKf8: true },
      parserFactories: parserFactories({
        mobi: new Error('invalid MOBI records'),
        kf8: goodKindleConfig()
      })
    });
    const report = chapters[0]?.kindleExtraction;
    assert(report?.selected === 'kf8-fallback', 'falls back to KF8 parser when MOBI parser fails');
    assert(report?.candidates.some(candidate => candidate.name === 'mobi-primary' && !candidate.ok), 'keeps failed MOBI candidate diagnostics');
  }

  {
    let error = null;
    try {
      await extractKindleChapters('/tmp/protected.azw3', {
        format: 'azw3',
        warn: false,
        container: { available: true, extension: 'azw3', likelyKf8: true },
        parserFactories: parserFactories({
          mobi: new Error('DRM protected content'),
          kf8: new Error('DRM protected content')
        })
      });
    } catch (err) {
      error = err;
    }
    assert(error?.kindleExtraction?.status === 'drm-protected', 'rejects DRM-protected Kindle files with diagnostics');
  }

  {
    const low = {
      ok: true,
      name: 'mobi-primary',
      parserKind: 'mobi',
      stats: { spineCount: 3, tocCount: 3 },
      metadata: { title: 'Tiny', author: 'A' },
      chapters: [{ title: 'Chapter 1', text: 'too short' }]
    };
    const quality = __test.scoreKindleExtractionCandidate(low);
    const status = __test.classifyKindleExtractionStatus({ ...low, quality });
    assert(quality.score < 55, 'scores tiny Kindle extraction below import threshold');
    assert(status.status === 'failed', 'classifies low-confidence Kindle extraction as failed');
  }

  {
    const metadata = await extractKindleMetadata('/tmp/book.azw3', 'azw3', {
      parserFactories: parserFactories({
        kf8: goodKindleConfig({ metadata: { title: 'Embedded Title', author: ['Embedded Author'], language: ['en'] } }),
        mobi: new Error('not MOBI')
      })
    });
    assert(metadata.title === 'Embedded Title', 'extracts Kindle metadata from parser');
    assert(metadata.author === 'Embedded Author', 'normalizes Kindle metadata arrays');
  }

  {
    const validation = assessExtractedContent([
      {
        title: 'Broken Kindle',
        text: prose(20, 900),
        kindleExtraction: { status: 'failed', score: 20, warnings: ['low text length'] }
      }
    ], { format: 'mobi' });
    assert(!validation.valid, 'import validation rejects failed Kindle extraction reports');
    assert(validation.errors.some(error => /Kindle extraction failed/.test(error)), 'reports Kindle extraction validation error');
  }

  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-kindle-test-'));
    const coverSource = path.join(dir, 'source-cover.jpg');
    const coverOutput = path.join(dir, 'out-cover.jpg');
    const resourceDir = path.join(dir, 'resources');
    await fs.mkdir(resourceDir);
    await fs.writeFile(coverSource, jpegFixture());
    const ok = await extractKindleCover('/tmp/book.mobi', 'mobi', coverOutput, {
      resourceSaveDir: resourceDir,
      parserFactories: parserFactories({
        mobi: goodKindleConfig({ coverPath: coverSource }),
        kf8: new Error('not KF8')
      })
    });
    const output = await fs.readFile(coverOutput);
    let resourceDirExists = true;
    try {
      await fs.access(resourceDir);
    } catch {
      resourceDirExists = false;
    }
    await fs.rm(dir, { recursive: true, force: true });
    assert(ok, 'extracts embedded Kindle cover');
    assert(output.equals(jpegFixture()), 'writes validated embedded Kindle cover bytes');
    assert(!resourceDirExists, 'cleans temporary Kindle resource directory');
  }

  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-kindle-invalid-cover-'));
    const coverSource = path.join(dir, 'source-cover.bin');
    const coverOutput = path.join(dir, 'out-cover.jpg');
    await fs.writeFile(coverSource, Buffer.from([1, 2, 3, 4]));
    const ok = await extractKindleCover('/tmp/book.azw3', 'azw3', coverOutput, {
      resourceSaveDir: path.join(dir, 'resources'),
      parserFactories: parserFactories({
        kf8: goodKindleConfig({ coverPath: coverSource }),
        mobi: new Error('not MOBI')
      })
    });
    let outputExists = true;
    try {
      await fs.access(coverOutput);
    } catch {
      outputExists = false;
    }
    await fs.rm(dir, { recursive: true, force: true });
    assert(!ok && !outputExists, 'rejects unsupported Kindle cover bytes before compact-source deletion');
  }

  console.log(`\nKindle extraction tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch(err => {
  failed++;
  console.error(`  FAIL Kindle extraction test crashed: ${err.message}`);
  console.log(`\nKindle extraction tests: ${passed} passed, ${failed} failed`);
  process.exit(1);
});
