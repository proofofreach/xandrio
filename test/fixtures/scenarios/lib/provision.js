'use strict';

// Builds a real DATA_DIR/CACHE_DIR tree for one named dataset ('cold',
// 'empty', 'full', 'degraded', 'login'), using the project's own chapter and
// book-guide modules so derived values (chapter normalization, guide source
// fingerprints) are byte-identical to what the real server computes at
// request time — never a hand-guessed hash that could drift and silently
// turn a "ready" fixture into "stale".

const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const crypto = require('node:crypto');

const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..');
const CONTENT_DIR = path.join(__dirname, '..', 'content');
const COVERS_DIR = path.join(__dirname, '..', 'covers');

const {
  splitOversizedChapters,
  repairTextArtifacts,
  normalizeChapterType,
  normalizeChapterSequence
} = require(path.join(REPO_ROOT, 'lib', 'chapter-utils'));
const { createBookGuideSourceSnapshot } = require(path.join(REPO_ROOT, 'lib', 'book-guide-source'));
const { chapterStructureKey } = require(path.join(REPO_ROOT, 'lib', 'chapter-structure'));
const jsonStoreLib = require(path.join(REPO_ROOT, 'lib', 'json-store'));
const { createAccountsStore } = require(path.join(REPO_ROOT, 'lib', 'accounts'));

// A fixed instant so every provisioned dataset is byte-for-byte reproducible
// across runs — screenshots must not drift because "addedAt" said "today".
const FIXED_NOW = '2026-08-01T12:00:00.000Z';

async function loadJson(name) {
  return JSON.parse(await fs.readFile(path.join(CONTENT_DIR, name), 'utf8'));
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function estimateDurationSeconds(text) {
  // ~14 characters/second is a middling narration rate; only used so
  // fixture books show plausible non-zero durations, never played back.
  return Math.max(3, Math.round(String(text || '').length / 14));
}

// Exactly mirrors lib/book-document.js's xbook branch of getChaptersCached,
// so a fingerprint computed here matches what the live server computes when
// it independently reads the same xbook artifact.
function repairedChapters(xbookChapters, { sourceFormat, work }) {
  const mapped = xbookChapters.map(chapter => {
    const repairedChapter = chapter && typeof chapter.text === 'string'
      ? { ...chapter, text: repairTextArtifacts(chapter.text) }
      : chapter;
    return normalizeChapterType(repairedChapter);
  });
  return normalizeChapterSequence(splitOversizedChapters(mapped), { sourceFormat, work });
}

async function writeJsonFile(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value));
}

async function writeBookXBook({ cacheDir, bookContent }) {
  const metadata = {
    title: bookContent.title,
    author: bookContent.author,
    publisher: bookContent.publisher,
    date: String(bookContent.publishedDate || ''),
    language: bookContent.language,
    description: bookContent.description
  };
  const rawChapters = bookContent.chapters.map(chapter => ({
    title: chapter.title,
    type: 'chapter',
    estimatedDuration: estimateDurationSeconds(chapter.text),
    text: chapter.text
  }));
  const xbookPath = path.join(cacheDir, `${bookContent.id}.xbook.json`);
  const artifact = {
    _xbookVersion: 1,
    processingVersion: 1,
    id: bookContent.id,
    sourceFormat: 'EPUB',
    sourceFilename: `${bookContent.id}.epub`,
    sourceSize: bookContent.chapters.reduce((sum, chapter) => sum + chapter.text.length, 0),
    sourceDeleted: true,
    extractedAt: FIXED_NOW,
    embeddedCover: false,
    metadata,
    chapters: rawChapters
  };
  await writeJsonFile(xbookPath, artifact);

  const coverSrc = path.join(COVERS_DIR, bookContent.cover);
  const coverDest = path.join(cacheDir, `${bookContent.id}_cover.jpg`);
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.copyFile(coverSrc, coverDest);

  // Same pipeline the real server runs when it reads this xbook, computed
  // once here so books.json and the guide fingerprint agree with it exactly.
  const liveChapters = repairedChapters(rawChapters, { sourceFormat: 'EPUB', work: metadata });
  return { xbookPath, coverPath: coverDest, liveChapters, metadata };
}

function booksStoreRecord(bookContent, { xbookPath, coverPath, liveChapters, overrides = {} }) {
  const chapterDurations = liveChapters.map(chapter => chapter.estimatedDuration ?? null);
  const totalDuration = chapterDurations.reduce((sum, value) => sum + (Number(value) || 0), 0);
  return {
    id: bookContent.id,
    title: bookContent.title,
    author: bookContent.author,
    publisher: bookContent.publisher,
    publishedDate: bookContent.publishedDate,
    subjects: [],
    language: bookContent.language,
    filename: `${bookContent.id}.epub`,
    path: xbookPath,
    uploadedFile: `${bookContent.title}.epub`,
    addedAt: FIXED_NOW,
    totalDuration,
    downloadSource: 'upload',
    coverPath,
    chapterCount: liveChapters.length,
    // Store the same structural provenance that a real import records. The
    // guide fixture below must derive its source identity from this persisted
    // record, not from the looser content template, or a future structure-key
    // change can manufacture a stale-guide warning in a nominally ready cell.
    chapterStructureKey: chapterStructureKey(liveChapters) || undefined,
    chapterDurations,
    audioGenerationState: 'not-started',
    ...(bookContent.nonfiction ? {
      studyGuideCategory: 'nonfiction',
      studyGuideCategorySetAt: FIXED_NOW
    } : {}),
    ...overrides
  };
}

function buildGuideArtifact({ book, liveChapters }) {
  const snapshot = createBookGuideSourceSnapshot({
    bookId: book.id,
    book,
    chapters: liveChapters
  });
  const firstChapterExcerpt = sha256Hex(liveChapters[0].text.slice(0, 240));
  const secondChapterExcerpt = sha256Hex((liveChapters[1] || liveChapters[0]).text.slice(0, 240));
  const anchors = {
    'orientation-thesis': { id: 'orientation-thesis', chapterIndex: 0, passageHash: `sha256:${firstChapterExcerpt}` },
    'concept-method': { id: 'concept-method', chapterIndex: 1 % liveChapters.length, passageHash: `sha256:${secondChapterExcerpt}` }
  };
  return {
    schemaVersion: 1,
    bookId: book.id,
    status: 'ready',
    createdAt: FIXED_NOW,
    source: {
      fingerprint: snapshot.fingerprint,
      language: snapshot.language,
      chapterStructureKey: snapshot.chapterStructureKey
    },
    models: {
      generator: { name: 'scenario-fixture-generator', digest: `sha256:${'a'.repeat(64)}` },
      verifier: { name: 'scenario-fixture-verifier', digest: `sha256:${'b'.repeat(64)}` }
    },
    anchors,
    guide: {
      orientation: {
        thesis: { text: 'Quiet is not the absence of sound; it is the absence of sounds a place does not belong to.', anchorId: 'orientation-thesis' },
        bottomLine: 'Measuring a place honestly means counting its own sounds separately from the ones that arrived from elsewhere.'
      },
      coreIdeas: [
        {
          title: 'True silence is a measurement artifact',
          claim: 'A microphone left overnight in the quietest valley still records hours of non-human sound.',
          anchorIds: ['orientation-thesis']
        },
        {
          title: 'Quiet intervals are vanishing statistically, not dramatically',
          claim: 'Most protected sites now log zero ten-minute windows free of any distant human sound each month.',
          anchorIds: ['concept-method']
        }
      ],
      chapterMap: liveChapters.map((chapter, index) => ({
        chapterIndex: index,
        title: chapter.title,
        purpose: index === 0
          ? 'Defines what researchers actually mean by a quiet place.'
          : 'Reports how rarely a true quiet interval now occurs.'
      })),
      review: {
        questions: [
          { question: 'Why do researchers reject silence as a literal description?', answer: 'Because every recorded site still carries wind, insects, and distant sound once measured closely.' },
          { question: 'What counts as a true quiet interval?', answer: 'Ten consecutive minutes with no human-sourced sound anywhere in the recording.' }
        ]
      },
      keyPassages: [
        { text: 'The first thing every acoustic ecologist learns in the field', anchorId: 'orientation-thesis' }
      ]
    },
    verification: {
      allClaimsChecked: true,
      unsupportedCount: 0,
      materialItemCount: 2,
      checkedItemCount: 2,
      claimCount: 2
    }
  };
}

function guideFailedJob(bookId) {
  return {
    id: `bg_scenario_${bookId}`,
    bookId,
    status: 'failed',
    phase: 'failed',
    current: 1,
    total: 2,
    attempt: 1,
    sourceFingerprint: 'sha256:scenario-degraded-fixture',
    chapterStructureKey: '',
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    errorCode: 'BOOK_GUIDE_GENERATION_FAILED',
    errorMessage: 'Scenario fixture: verification step failed (synthetic, no live provider was called).'
  };
}

async function seedPositions({ dataDir, entries }) {
  await writeJsonFile(path.join(dataDir, 'positions.json'), { users: { default: entries } });
}

async function seedShelves({ dataDir, bookIds }) {
  const books = {};
  bookIds.forEach((id, index) => {
    books[id] = { addedAt: new Date(Date.parse(FIXED_NOW) + index * 1000).toISOString() };
  });
  await writeJsonFile(path.join(dataDir, 'shelves.json'), { users: { default: { books } } });
}

async function seedSettings({ dataDir, voice = 'kokoro:am_onyx', operatorPolicyAcknowledged }) {
  const settings = { voice, premiumPrepEnabled: true };
  if (operatorPolicyAcknowledged) {
    settings.operatorPolicy = {
      version: 1,
      acknowledgedAt: FIXED_NOW,
      // Deliberately left off. This single flag also unlocks Anna's Archive
      // and Z-Library, both of which report configured:true unconditionally
      // (lib/search-providers/index.js) and, for Anna's, invoke a real
      // headless-browser navigation with no configurable local origin — a
      // live network call the network guard cannot intercept (it patches
      // Node's http/https, not a separate browser process's own sockets).
      // Leaving this off keeps every "unverified" source (Anna's,
      // Z-Library, *and* Internet Archive) behind the real acknowledgement
      // gate, which is itself a real, useful state to have in the matrix —
      // see docs/SCENARIO_SERVER.md.
      unverifiedSourcesEnabled: false
    };
  }
  await writeJsonFile(path.join(dataDir, 'settings.json'), settings);
}

async function seedClientSettings({ dataDir }) {
  await writeJsonFile(path.join(dataDir, 'client-settings.json'), {
    users: {
      default: {
        skipIntervalSeconds: 15,
        progressDisplayMode: 'elapsed',
        // internetarchive/annas/zlibrary/opds are deliberately excluded:
        // all four sit behind the operator's "unverified sources"
        // acknowledgement (a self-hosted custom OPDS catalog is inherently
        // unverified too), which this harness leaves off — see
        // seedSettings. Defaulting to any of them here would 409 every
        // scenario search. The custom-OPDS provider stub/fixture still
        // exists for a deliberate run that flips the flag on.
        defaultSearchSources: ['gutenberg', 'standardebooks']
      }
    }
  });
}

async function seedBookGuideConfig({ dataDir, enabled }) {
  await writeJsonFile(path.join(dataDir, 'book-guide-config.json'), {
    version: 1,
    enabled,
    allowUncertified: true,
    externalProcessingAcknowledgedAt: enabled ? FIXED_NOW : null,
    baseUrl: 'http://scenario-fixture.invalid/book-guide-provider',
    generator: { name: 'scenario-fixture-generator', digest: `sha256:${'a'.repeat(64)}` },
    verifier: { name: 'scenario-fixture-verifier', digest: `sha256:${'b'.repeat(64)}` },
    configuredAt: enabled ? FIXED_NOW : null
  });
  if (enabled) {
    await writeJsonFile(path.join(dataDir, 'book-guide-provider.json'), {
      version: 1,
      // Not a real credential: this instance never reaches a real network
      // host (see lib/network-guard.js), so an unusable placeholder is safe.
      apiKey: 'scenario-fixture-not-a-real-key',
      updatedAt: FIXED_NOW
    });
  }
}

async function seedAccount({ dataDir }) {
  const store = createAccountsStore({
    filePath: path.join(dataDir, 'accounts.json'),
    jsonStore: jsonStoreLib
  });
  await store.createAccount({
    username: 'reader',
    password: 'scenario-demo-only',
    displayName: 'Scenario Reader',
    role: 'admin'
  });
}

// bookId -> extra books.json overrides used to shape the 'full' dataset's
// stats/library mix without hand-writing four near-duplicate records.
const FULL_OVERRIDES = {
  'scn-meridian': { audioGenerationState: 'ready', audioGeneratedChapters: 3, audioGenerationTotal: 3 },
  'scn-lighthouse': { audioGenerationState: 'ready', audioGeneratedChapters: 3, audioGenerationTotal: 3 },
  'scn-fieldnotes': { audioGenerationState: 'ready', audioGeneratedChapters: 3, audioGenerationTotal: 3 },
  'scn-driftwood': {}
};

const DEGRADED_OVERRIDES = {
  'scn-meridian': { audioGenerationState: 'ready', audioGeneratedChapters: 3, audioGenerationTotal: 3 },
  'scn-fieldnotes': {
    audioGenerationState: 'partial',
    audioGeneratedChapters: 1,
    audioGenerationTotal: 3,
    audioGenerationError: 'Scenario fixture: chatterbox engine unavailable (synthetic, no live provider was called).'
  }
};

async function provisionDataset({ dataDir, cacheDir, dataset }) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(cacheDir, { recursive: true });
  const books = await loadJson('books.json');

  const cold = dataset === 'cold';

  if (dataset === 'empty' || dataset === 'login') {
    await seedSettings({ dataDir, operatorPolicyAcknowledged: true });
    await writeJsonFile(path.join(dataDir, 'books.json'), {});
    await writeJsonFile(path.join(dataDir, 'positions.json'), { users: { default: {} } });
    await writeJsonFile(path.join(dataDir, 'shelves.json'), { users: { default: { books: {} } } });
    await seedClientSettings({ dataDir });
    await seedBookGuideConfig({ dataDir, enabled: false });
    if (dataset === 'login') await seedAccount({ dataDir });
    return;
  }

  const overrides = dataset === 'degraded' ? DEGRADED_OVERRIDES : FULL_OVERRIDES;
  const included = dataset === 'degraded'
    ? books.filter(book => ['scn-meridian', 'scn-fieldnotes'].includes(book.id))
    : books;

  const booksStore = {};
  let guideArtifactFieldnotes = null;
  let fieldnotesLiveChapters = null;

  for (const bookContent of included) {
    const { xbookPath, coverPath, liveChapters } = await writeBookXBook({ cacheDir, bookContent });
    booksStore[bookContent.id] = booksStoreRecord(bookContent, {
      xbookPath,
      coverPath,
      liveChapters,
      overrides: overrides[bookContent.id] || {}
    });
    if (bookContent.id === 'scn-fieldnotes') {
      fieldnotesLiveChapters = liveChapters;
      if (dataset !== 'degraded') {
        guideArtifactFieldnotes = buildGuideArtifact({ book: booksStore[bookContent.id], liveChapters });
      }
    }
  }

  await writeJsonFile(path.join(dataDir, 'books.json'), booksStore);
  // A cold instance is unacknowledged, not necessarily empty. Keep the real
  // synthetic library behind the first-run notice so deep routes such as the
  // player do not manufacture an unrelated "Couldn't open book" error. The
  // absence of settings.json is what makes the operator notice authoritative.
  if (!cold) await seedSettings({ dataDir, operatorPolicyAcknowledged: true });
  await seedClientSettings({ dataDir });
  await seedShelves({ dataDir, bookIds: Object.keys(booksStore) });
  await seedBookGuideConfig({ dataDir, enabled: true });

  if (dataset === 'full') {
    // scn-meridian: mid-book, actively in progress.
    // scn-lighthouse: finished.
    // scn-fieldnotes / scn-driftwood: untouched, so the library shows a mix.
    await seedPositions({
      dataDir,
      entries: {
        'scn-meridian': {
          userId: 'default', bookId: 'scn-meridian', chapterIndex: 1, timestamp: 240,
          chunkIndex: 2, chunkTime: 12.5, playbackRate: 1, wasPlaying: false, finished: false,
          chapterStructureKey: booksStore['scn-meridian'].chapterStructureKey,
          updatedAt: FIXED_NOW, updatedAtMs: Date.parse(FIXED_NOW)
        },
        'scn-lighthouse': {
          userId: 'default', bookId: 'scn-lighthouse', chapterIndex: 2, timestamp: 300,
          playbackRate: 1, wasPlaying: false, finished: true,
          chapterStructureKey: booksStore['scn-lighthouse'].chapterStructureKey,
          updatedAt: FIXED_NOW, updatedAtMs: Date.parse(FIXED_NOW)
        }
      }
    });
  } else if (dataset === 'degraded') {
    await seedPositions({
      dataDir,
      entries: {
        'scn-meridian': {
          userId: 'default', bookId: 'scn-meridian', chapterIndex: 0, timestamp: 30,
          playbackRate: 1, wasPlaying: false, finished: false,
          chapterStructureKey: booksStore['scn-meridian'].chapterStructureKey,
          updatedAt: FIXED_NOW, updatedAtMs: Date.parse(FIXED_NOW)
        }
      }
    });
    await writeJsonFile(path.join(dataDir, 'book-guide-jobs.json'), {
      version: 1,
      jobs: { [`bg_scenario_scn-fieldnotes`]: guideFailedJob('scn-fieldnotes') }
    });
  }

  if (guideArtifactFieldnotes) {
    const guideDir = path.join(cacheDir, 'book-guides');
    await writeJsonFile(path.join(guideDir, 'scn-fieldnotes.guide.json'), guideArtifactFieldnotes);
  }

  return { fieldnotesLiveChapters };
}

module.exports = { provisionDataset, FIXED_NOW };
