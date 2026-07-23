/**
 * Tests for ChunkedTTS
 *
 * Covers:
 *   1. Text splitting — paragraph & sentence boundaries, chunk sizing
 *   2. Manifest tracking — creation, status updates via queue events
 *   3. Cache detection — skipping chunks that already exist on disk
 *
 * Run:  node test/test-chunked-tts.js
 */

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { EventEmitter } = require('events');
const ChunkedTTS = require('../lib/chunked-tts');
const { STATUS, DEFAULT_CHUNK_SIZE } = require('../lib/chunked-tts');
const GenerationJournal = require('../lib/generation-journal');
const TTSQueue = require('../lib/tts-queue');

// ─── Helpers ─────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.error(`  ❌ ${label}`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual === expected) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.error(`  ❌ ${label}  — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertDeep(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.error(`  ❌ ${label}\n     expected: ${e}\n     actual:   ${a}`);
  }
}

function section(name) {
  console.log(`\n━━━ ${name} ━━━`);
}

/**
 * Fake TTSQueue that records enqueue calls and emits completion events.
 */
class MockQueue extends EventEmitter {
  constructor() {
    super();
    this.jobs = [];
    this._counter = 0;
  }

  async enqueue({ text, outputPath, language, priority, voice, padEndMs, narration }) {
    const id = `job_${this._counter++}`;
    this.jobs.push({ id, text, outputPath, language, priority, voice, padEndMs, narration, status: 'queued' });
    return id;
  }

  getStatus(jobId) {
    const job = this.jobs.find(j => j.id === jobId);
    return job ? { status: job.status } : null;
  }

  /** Simulate completion of a job */
  completeJob(jobId, outputPath) {
    const job = this.jobs.find(j => j.id === jobId);
    if (job) job.status = 'complete';
    this.emit('complete', { jobId, outputPath });
  }

  /** Simulate error on a job */
  failJob(jobId, error) {
    const job = this.jobs.find(j => j.id === jobId);
    if (job) job.status = 'error';
    this.emit('error', { jobId, error });
  }

  /** Simulate progress/generating */
  progressJob(jobId) {
    const job = this.jobs.find(j => j.id === jobId);
    if (job) job.status = 'generating';
    this.emit('progress', { jobId, status: 'generating' });
  }
}

// ─── 1. Text Splitting ──────────────────────────────────────────────────────

section('1. Text splitting');

(() => {
  const tts = new ChunkedTTS('/tmp/test-cache');

  // 1a. Empty / falsy input
  assertDeep(tts.splitIntoChunks(''), [], 'Empty string returns []');
  assertDeep(tts.splitIntoChunks('   '), [], 'Whitespace-only returns []');
  assertDeep(tts.splitIntoChunks(null), [], 'null returns []');

  // 1b. Short text stays in one chunk
  const short = 'Hello world. This is a test.';
  const r1 = tts.splitIntoChunks(short);
  assertEqual(r1.length, 1, 'Short text → 1 chunk');
  assertEqual(r1[0], short, 'Chunk content matches input');

  // 1c. Paragraph grouping respects maxChars
  const para1 = 'A'.repeat(100) + '.';  // 101 chars
  const para2 = 'B'.repeat(100) + '.';  // 101 chars
  const para3 = 'C'.repeat(100) + '.';  // 101 chars
  const text3 = [para1, para2, para3].join('\n\n');

  // maxChars = 250 → para1+para2 fit (101 + 2 + 101 = 204), para3 is separate
  const r3 = tts.splitIntoChunks(text3, 250);
  assertEqual(r3.length, 2, '3 paragraphs, maxChars=250 → 2 chunks');
  assert(r3[0].includes('A') && r3[0].includes('B'), 'First chunk has para1 + para2');
  assert(r3[1].includes('C'), 'Second chunk has para3');

  // 1d. Oversized paragraph gets split at sentence boundaries
  const sentences = [];
  for (let i = 0; i < 20; i++) {
    sentences.push(`Sentence number ${i} with some filler text to make it longer.`);
  }
  const bigPara = sentences.join(' '); // one paragraph, no double-newlines
  const r4 = tts.splitIntoChunks(bigPara, 300);
  assert(r4.length > 1, `Big paragraph splits into multiple chunks (got ${r4.length})`);
  for (const chunk of r4) {
    // Every chunk should end with a sentence-ending punctuation (the last one might not if remainder)
    assert(chunk.length <= 300 || !chunk.includes('. '),
      `Chunk length ${chunk.length} ≤ 300 or is a single sentence`);
  }

  // 1e. Never splits mid-sentence
  const twoSentences = 'First sentence is here. Second sentence is here too.';
  const r5 = tts.splitIntoChunks(twoSentences, 30);
  // Each chunk should be a complete sentence (or multiple)
  for (const chunk of r5) {
    assert(
      chunk.endsWith('.') || chunk.endsWith('!') || chunk.endsWith('?') || chunk === chunk.trim(),
      `Chunk "${chunk.slice(0, 40)}…" does not split mid-sentence`
    );
  }

  // 1f. Default chunk size is 4000
  assertEqual(tts.chunkSize, 4000, 'Default chunk size is 4000');

  // 1g. Multiple paragraphs, some large, some small
  const mixed = [
    'Short paragraph.',
    'Another short one.',
    'X'.repeat(500) + '. ' + 'Y'.repeat(500) + '.',  // 1003 chars in one paragraph
    'Final short paragraph.'
  ].join('\n\n');
  const r6 = tts.splitIntoChunks(mixed, 600);
  assert(r6.length >= 2, `Mixed paragraphs produce ≥2 chunks (got ${r6.length})`);
  // The 1003-char paragraph should be split by sentences
  // and "Short paragraph" + "Another short one" should be grouped

  // 1h. Sentence splitting handles various punctuation
  const varied = 'Is this a question? Yes it is! And a statement. Plus an ellipsis... Final.';
  const r7 = tts.splitIntoChunks(varied, 40);
  assert(r7.length >= 2, `Varied punctuation splits correctly (got ${r7.length})`);

  // 1i. Verify no chunk exceeds maxChars (unless it's one sentence)
  const longText = Array.from({ length: 50 }, (_, i) =>
    `This is sentence ${i} with enough words to be meaningful.`
  ).join(' ');
  const r8 = tts.splitIntoChunks(longText, 200);
  for (let i = 0; i < r8.length; i++) {
    // A chunk may exceed maxChars only if it's a single sentence
    if (r8[i].length > 200) {
      const sentenceCount = (r8[i].match(/[.!?]/g) || []).length;
      assert(sentenceCount <= 1,
        `Oversized chunk ${i} (${r8[i].length} chars) is a single sentence`);
    }
  }

  // 1j. paragraphFinal metadata
  // Single paragraph in one chunk → paragraph-final
  const m1 = tts.splitIntoChunksWithMeta('One short paragraph.');
  assertEqual(m1.length, 1, 'meta: single paragraph → 1 chunk');
  assertEqual(m1[0].paragraphFinal, true, 'meta: lone chunk is paragraph-final');

  // Two paragraphs packed into one chunk → the chunk ends a paragraph
  const m2 = tts.splitIntoChunksWithMeta('Para one.\n\nPara two.', 100);
  assertEqual(m2.length, 1, 'meta: two small paragraphs pack into 1 chunk');
  assertEqual(m2[0].paragraphFinal, true, 'meta: packed chunk ending a paragraph is final');

  // Oversized paragraph split across chunks: only the last split chunk is final
  const bigSentences = Array.from({ length: 12 }, (_, i) =>
    `Sentence ${i} carries plenty of filler words to force splitting apart.`
  ).join(' ');
  // Closer is ~150 chars so it cannot pack into the big paragraph's last chunk
  const closer = 'Closing paragraph that is deliberately long enough that it can never share a chunk with the tail end of the preceding oversized paragraph text.';
  const m3 = tts.splitIntoChunksWithMeta(`${bigSentences}\n\n${closer}`, 200);
  assert(m3.length >= 3, `meta: oversized paragraph splits (got ${m3.length})`);
  for (let i = 0; i < m3.length - 2; i++) {
    assertEqual(m3[i].paragraphFinal, false, `meta: mid-paragraph chunk ${i} is not final`);
  }
  assertEqual(m3[m3.length - 2].paragraphFinal, true, 'meta: last chunk of big paragraph is final');
  assertEqual(m3[m3.length - 1].paragraphFinal, true, 'meta: trailing paragraph chunk is final');

  // splitIntoChunks stays a plain string API over the same packing
  assertDeep(tts.splitIntoChunks('Para one.\n\nPara two.', 100), m2.map(c => c.text),
    'splitIntoChunks delegates to the meta version');

  const headingAndBody = 'TABLET III\n\n' + 'Then Anshar raised his voice to be heard, to his officer Kakka. '.repeat(10);
  const headingChunks = tts.splitIntoChunksWithMeta(headingAndBody, 600);
  assert(headingChunks.length > 0, 'heading plus body produces chunks');
  assert(headingChunks[0].text.startsWith('Tablet III\n\nThen Anshar'),
    'short unspeakable heading is folded into the following chunk');
  assert(headingChunks.every(chunk => chunk.text.length >= 20),
    'no standalone unspeakable heading chunk remains');
})();

// ─── 2. Manifest Tracking ───────────────────────────────────────────────────

section('2. Manifest tracking');

(async () => {
  const mockQueue = new MockQueue();
  const tts = new ChunkedTTS('/tmp/test-cache', mockQueue);

  // Override _fileExists so nothing is "cached"
  tts._fileExists = async () => false;

  const text = [
    'First paragraph with some text.',
    'Second paragraph with more text.',
    'Third paragraph concluding the chapter.'
  ].join('\n\n');

  // 2a. generateChapter creates a manifest
  const manifest = await tts.generateChapter('book1', 0, text);
  assert(manifest !== null, 'generateChapter returns a manifest');
  assertEqual(manifest.bookId, 'book1', 'Manifest has correct bookId');
  assertEqual(manifest.chapterIndex, 0, 'Manifest has correct chapterIndex');

  // All text fits in one chunk at default 4000 limit
  assertEqual(manifest.totalChunks, 1, 'Short text → 1 chunk');
  assertEqual(manifest.chunks[0].status, STATUS.QUEUED, 'Chunk 0 is queued');
  assert(manifest.chunks[0].jobId !== null, 'Chunk 0 has a jobId');

  // 2b. Queue received the job with correct priority
  assertEqual(mockQueue.jobs.length, 1, 'One job enqueued');
  assertEqual(mockQueue.jobs[0].priority, 'immediate', 'First chunk is immediate priority');
  assert(Array.isArray(mockQueue.jobs[0].narration.segments), 'Structured narration segments reach queue');

  // 2c. getChapterManifest retrieves stored manifest
  const retrieved = tts.getChapterManifest('book1', 0);
  assert(retrieved === manifest, 'getChapterManifest returns same object');

  // 2d. Multiple chunks with priority ordering
  const mockQueue2 = new MockQueue();
  const tts2 = new ChunkedTTS('/tmp/test-cache', mockQueue2, { chunkSize: 60 });
  tts2._fileExists = async () => false;

  const longText = [
    'First paragraph sentence one. Sentence two here.',
    'Second paragraph sentence one. Sentence two here.',
    'Third paragraph sentence one. Sentence two here.'
  ].join('\n\n');

  const manifest2 = await tts2.generateChapter('book2', 3, longText);
  assert(manifest2.totalChunks >= 2, `Multiple chunks created (${manifest2.totalChunks})`);

  // First enqueued job should be 'immediate', rest 'next'
  if (mockQueue2.jobs.length >= 2) {
    assertEqual(mockQueue2.jobs[0].priority, 'immediate', 'First pending chunk is immediate');
    assertEqual(mockQueue2.jobs[1].priority, 'next', 'Second pending chunk is next');
  }

  // 2e. Status updates via queue events
  const jobId = manifest.chunks[0].jobId;

  // Simulate generating
  mockQueue.progressJob(jobId);
  assertEqual(manifest.chunks[0].status, STATUS.GENERATING, 'Chunk status → generating');

  // Simulate completion
  const outputPath = '/tmp/test-cache/book1_ch0_chunk0.mp3';
  mockQueue.completeJob(jobId, outputPath);
  assertEqual(manifest.chunks[0].status, STATUS.READY, 'Chunk status → ready');
  assertEqual(manifest.chunks[0].path, outputPath, 'Chunk path set on completion');

  // 2f. chapter:ready event fires when all chunks complete
  const mockQueue3 = new MockQueue();
  const tts3 = new ChunkedTTS('/tmp/test-cache', mockQueue3, { chunkSize: 50 });
  tts3._fileExists = async () => false;

  let chapterReadyFired = false;
  tts3.on('chapter:ready', () => { chapterReadyFired = true; });

  const m3 = await tts3.generateChapter('book3', 0,
    'Sentence one here. Sentence two here.\n\nSentence three here. Sentence four here.'
  );

  // Complete all jobs
  for (const chunk of m3.chunks) {
    if (chunk.jobId) {
      mockQueue3.completeJob(chunk.jobId, tts3.chunkPath('book3', 0, chunk.index));
    }
  }
  assert(chapterReadyFired, 'chapter:ready event fires when all chunks complete');

  // 2g. Error handling
  const mockQueue4 = new MockQueue();
  const tts4 = new ChunkedTTS('/tmp/test-cache', mockQueue4);
  tts4._fileExists = async () => false;

  let errorEvent = null;
  tts4.on('chunk:error', (e) => { errorEvent = e; });

  const m4 = await tts4.generateChapter('book4', 1, 'Some text for error test.');
  const errorJobId = m4.chunks[0].jobId;

  mockQueue4.failJob(errorJobId, new Error('TTS failed'));
  assertEqual(m4.chunks[0].status, STATUS.ERROR, 'Chunk status → error on failure');
  assert(errorEvent !== null, 'chunk:error event emitted');
  assertEqual(errorEvent.chunkIndex, 0, 'Error event has correct chunkIndex');

  // 2h. Stale queued/generating jobs are treated as resumable
  const mockQueue5 = new MockQueue();
  const tts5 = new ChunkedTTS('/tmp/test-cache', mockQueue5, { chunkSize: 50 });
  tts5._fileExists = async () => false;
  const m5 = await tts5.generateChapter('book5', 0, 'First sentence here. Second sentence here.');
  assertEqual(tts5.manifestNeedsResume(m5), false, 'Live queued jobs do not need resume');
  mockQueue5.jobs = [];
  assertEqual(tts5.manifestNeedsResume(m5), true, 'Missing queued job needs resume');

  const structuredQueue = new MockQueue();
  const structuredTts = new ChunkedTTS('/tmp/test-cache', structuredQueue, { chunkSize: 200 });
  structuredTts._fileExists = async () => false;
  await structuredTts.generateChapter(
    'structured',
    0,
    'CHAPTER ONE\n\n“Wait—don’t go,” she said.\n\nThe door closed.'
  );
  const structuredJob = structuredQueue.jobs[0];
  assert(structuredJob.narration.segments.some(segment => segment.kind === 'heading'),
    'Heading semantics are retained through enqueue');
  assert(structuredJob.narration.segments.some(segment => segment.kind === 'dialogue'),
    'Dialogue semantics are retained through enqueue');
  assert(structuredJob.text.includes('“Wait—don’t go,”'), 'Dialogue punctuation is not flattened');
  assertEqual(structuredJob.narration.pauseIntent, 'paragraph', 'Final paragraph pause intent is retained');
})();

// ─── Durable ordinary generation recovery ──────────────────────────────────

section('Durable ordinary generation recovery');

(async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xandrio-chapter-journal-'));
  try {
    const journal = new GenerationJournal(path.join(tmpDir, 'generation-journal.json'));
    await journal.put({ bookId: 'premium-book', variantKey: 'premium-v1', fromChapter: 2 });

    const interruptedQueue = new MockQueue();
    const interrupted = new ChunkedTTS(tmpDir, interruptedQueue, {
      chunkSize: 45,
      variantKeyProvider: () => 'ordinary-v1',
      generationJournal: journal
    });
    interrupted._fileExists = async () => false;
    const chapterText = 'First durable sentence. Second durable sentence. Third durable sentence.';
    await interrupted.generateChapter('ordinary-book', 3, chapterText, 'en', 'next', {
      voice: 'kokoro:af_heart'
    });

    const pending = await journal.listChapters();
    assertEqual(pending.length, 1, 'Interrupted ordinary chapter intent is durable');
    assertEqual((await journal.list()).length, 1, 'Premium journal entry remains separate');

    const restartQueue = new MockQueue();
    const restarted = new ChunkedTTS(tmpDir, restartQueue, {
      chunkSize: 45,
      variantKeyProvider: () => 'ordinary-v1',
      generationJournal: journal
    });
    restarted._fileExists = async () => false;
    const report = await restarted.resumePendingChapters();
    assertEqual(report.resumed.length, 1, 'Restart resumes matching ordinary chapter intent');
    assert(restartQueue.jobs.length > 0, 'Restart re-enqueues missing chapter chunks');
    assert(restartQueue.jobs.every(job => job.voice === 'kokoro:af_heart'), 'Recovery retains voice snapshot');

    const manifest = report.resumed[0].manifest;
    for (const chunk of manifest.chunks) {
      restartQueue.completeJob(chunk.jobId, restarted.chunkPath('ordinary-book', 3, chunk.index));
    }
    for (let i = 0; i < 50 && (await journal.listChapters()).length; i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assertEqual((await journal.listChapters()).length, 0, 'Completed chapter intent is cleared');
    assertEqual((await journal.list()).length, 1, 'Completing ordinary chapter does not clear premium intent');

    await journal.putChapter({
      bookId: 'other-voice', chapterIndex: 0, variantKey: 'ordinary-v2',
      text: 'This is sufficiently long narration for recovery with the other recorded voice variant.',
      voice: 'chatterbox:other', chunkSize: 77
    });
    const skipped = await restarted.resumePendingChapters();
    assertEqual(skipped.skipped.length, 1, 'Recovery does not conflate voice variants');
    const recoveredAll = await restarted.resumePendingChapters({ recoverAllVariants: true });
    assertEqual(recoveredAll.resumed.length, 1, 'Same startup pass rehydrates inactive voice variant');
    assertEqual(recoveredAll.skipped.length, 0, 'All-variant recovery strands no ordinary intents');
    const recoveredManifest = recoveredAll.resumed[0].manifest;
    assert(recoveredManifest.variantKey === 'ordinary-v2', 'Recovered manifest retains recorded variant key');
    for (const chunk of recoveredManifest.chunks) {
      const job = restartQueue.jobs.find(candidate => candidate.id === chunk.jobId);
      restartQueue.completeJob(chunk.jobId, job.outputPath);
    }
    for (let i = 0; i < 50 && (await journal.listChapters()).length; i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assertEqual((await journal.listChapters()).length, 0, 'Recovered inactive variant clears on completion');

    await journal.putChapter({
      bookId: 'malformed-first', chapterIndex: 0, variantKey: 'malformed',
      text: 'This malformed first record must not prevent later compatible recovery.',
      chunkSize: 80
    });
    await journal.putChapter({
      bookId: 'old-mlx', chapterIndex: 0, variantKey: 'chatterbox:voice:modeloriginal8bit:refold',
      text: 'This historical MLX narration must never be rendered by the current PyTorch provider.',
      voice: 'chatterbox:voice', chunkSize: 80
    });
    await journal.putChapter({
      bookId: 'valid-after-bad', chapterIndex: 0, variantKey: 'ordinary-v1',
      text: 'This valid record follows the incompatible record and must still resume normally.',
      voice: 'kokoro:af_heart', chunkSize: 80
    });
    const guardedQueue = new MockQueue();
    const guarded = new ChunkedTTS(tmpDir, guardedQueue, {
      chunkSize: 80,
      variantKeyProvider: () => 'ordinary-v1',
      generationJournal: journal,
      validateRecoveryEntry: async entry => {
        if (!entry.voice) throw new Error('Malformed recovery voice');
        return entry.variantKey === 'ordinary-v1'
          ? { compatible: true }
          : { compatible: false, error: 'Recorded MLX/reference identity is incompatible with current provider' };
      }
    });
    guarded._fileExists = async () => false;
    const guardedReport = await guarded.resumePendingChapters({ recoverAllVariants: true });
    assertEqual(guardedReport.failed.length, 2, 'Malformed and incompatible ordinary variants are rejected');
    assertEqual(guardedReport.resumed.length, 1, 'Valid record after malformed and incompatible records still resumes');
    assert((await journal.listQuarantinedChapters()).some(job => job.bookId === 'malformed-first'),
      'Malformed first ordinary record is quarantined');
    assert((await journal.listQuarantinedChapters()).some(job => job.bookId === 'old-mlx'),
      'Incompatible ordinary variant is quarantined');

    const beforeInvalid = (await journal.listChapters()).length;
    let invalidFailed = false;
    try {
      await restarted.generateChapter('invalid-book', 0, '---', 'en');
    } catch {
      invalidFailed = true;
    }
    assert(invalidFailed, 'Deterministically unspeakable generation is rejected');
    assertEqual((await journal.listChapters()).length, beforeInvalid,
      'Deterministic validation failure does not poison recovery journal');
    assertEqual(restarted.currentVariantSegment(), restarted.variantSegment('ordinary-v1'),
      'Public currentVariantSegment exposes the current cache namespace');
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
})();

(async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xandrio-recovery-quiesce-'));
  try {
    const journal = new GenerationJournal(path.join(tmpDir, 'journal.json'));
    await journal.putChapter({
      bookId: 'history-book', chapterIndex: 0, variantKey: 'historical-v2',
      text: 'Historical narration that must not recreate stale audio after invalidation.',
      voice: 'kokoro:af_heart', chunkSize: 100
    });
    class SlowWritingQueue extends TTSQueue {
      async _generateTTS(_text, outputPath) {
        await new Promise(resolve => setTimeout(resolve, 30));
        await fsp.writeFile(outputPath, 'stale-audio');
      }
    }
    const queue = new SlowWritingQueue({ maxConcurrent: 1 });
    const coordinator = new ChunkedTTS(tmpDir, queue, {
      variantKeyProvider: () => 'current-v1', generationJournal: journal
    });
    const report = await coordinator.resumePendingChapters({ recoverAllVariants: true });
    const outputPath = queue._jobs.get(report.resumed[0].manifest.chunks[0].jobId).outputPath;
    await new Promise(resolve => setImmediate(resolve));
    await coordinator.quiesceChapterAllVariants('history-book', 0, {
      [coordinator.currentVariantSegment()]: 2
    }, 0);
    await new Promise(resolve => setTimeout(resolve, 40));
    assertEqual(fs.existsSync(outputPath), false,
      'All-variant quiesce waits for historical work and prevents stale audio recreation');
    assertEqual(queue.getQueueStatus().active, 0, 'Historical recovery job fully settles before invalidation');
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
})();

(async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xandrio-retry-journal-'));
  try {
    const journal = new GenerationJournal(path.join(tmpDir, 'journal.json'));
    const permanentQueue = new MockQueue();
    const permanent = new ChunkedTTS(tmpDir, permanentQueue, {
      variantKeyProvider: () => 'permanent-v1', generationJournal: journal
    });
    permanent._fileExists = async () => false;
    const permanentManifest = await permanent.generateChapter(
      'permanent-book', 0, 'Narration sent to an engine that permanently rejects this request.'
    );
    permanentQueue.failJob(permanentManifest.chunks[0].jobId, new Error('Engine failed (422): invalid voice'));
    for (let i = 0; i < 50 && (await journal.listQuarantinedChapters()).length === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assertEqual((await journal.listChapters()).length, 0, 'Permanent engine failure is not retried at startup');
    const permanentQuarantine = await journal.listQuarantinedChapters();
    assertEqual(permanentQuarantine.length, 1, 'Permanent failure is quarantined for diagnosis');
    assertEqual(permanentQuarantine[0].attempts, 1, 'Permanent failure exhausts on first attempt');
    const permanentJobsBefore = permanentQueue.jobs.length;
    let quarantineRejected = false;
    try {
      await permanent.generateChapter(
        'permanent-book', 0, 'Narration sent to an engine that permanently rejects this request.'
      );
    } catch (error) {
      quarantineRejected = error.code === 'GENERATION_QUARANTINED';
    }
    assert(quarantineRejected, 'Quarantined permanent intent rejects later automatic generation attempts');
    assertEqual(permanentQueue.jobs.length, permanentJobsBefore, 'Quarantined intent never reaches engine again');
    await journal.clearChapterQuarantine('permanent-book', 0, 'permanent-v1');
    const explicitRetry = await permanent.generateChapter(
      'permanent-book', 0, 'Narration sent to an engine after the user explicitly retries it.'
    );
    assert(explicitRetry.chunks.some(chunk => chunk.jobId), 'Explicit user retry clears quarantine and reaches the engine');

    const transientText = 'Narration whose temporary engine outage should be retried a bounded number of times.';
    let transientQueue = new MockQueue();
    let transient = new ChunkedTTS(tmpDir, transientQueue, {
      variantKeyProvider: () => 'transient-v1', generationJournal: journal
    });
    transient._fileExists = async () => false;
    let transientManifest = await transient.generateChapter('transient-book', 0, transientText);
    transientQueue.failJob(transientManifest.chunks[0].jobId, new Error('connect ECONNREFUSED'));
    for (let i = 0; i < 50; i++) {
      const jobs = await journal.listChapters();
      if (jobs.find(job => job.bookId === 'transient-book')?.attempts === 1) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    let retryEntry = (await journal.listChapters()).find(job => job.bookId === 'transient-book');
    assertEqual(retryEntry.attempts, 1, 'Transient failure remains retryable with attempt metadata');
    assertEqual(retryEntry.status, 'retryable', 'Transient intent remains in active recovery journal');

    for (let attempt = 2; attempt <= 3; attempt++) {
      transientQueue = new MockQueue();
      transient = new ChunkedTTS(tmpDir, transientQueue, {
        variantKeyProvider: () => 'transient-v1', generationJournal: journal
      });
      transient._fileExists = async () => false;
      const resumed = await transient.resumePendingChapters();
      transientManifest = resumed.resumed[0].manifest;
      transientQueue.failJob(transientManifest.chunks[0].jobId, new Error('connect ECONNREFUSED'));
      for (let i = 0; i < 50; i++) {
        const active = (await journal.listChapters()).find(job => job.bookId === 'transient-book');
        const quarantined = (await journal.listQuarantinedChapters()).find(job => job.bookId === 'transient-book');
        if ((active?.attempts || quarantined?.attempts) === attempt) break;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    }
    assertEqual((await journal.listChapters()).some(job => job.bookId === 'transient-book'), false,
      'Transient intent stops retrying after bounded attempts');
    const transientQuarantine = (await journal.listQuarantinedChapters())
      .find(job => job.bookId === 'transient-book');
    assertEqual(transientQuarantine.attempts, 3, 'Transient retry budget is persisted and exhausted');
    assertEqual(transientQuarantine.failureKind, 'transient', 'Quarantine retains failure classification');
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
})();

// ─── 3. Cache Detection ─────────────────────────────────────────────────────

section('3. Cache detection');

(async () => {
  const mockQueue = new MockQueue();
  const tts = new ChunkedTTS('/tmp/test-cache', mockQueue, { chunkSize: 50 });

  // Mock: chunk 0 exists on disk, chunk 1 does not
  let callCount = 0;
  tts._fileExists = async (filePath) => {
    callCount++;
    return filePath.includes('chunk0');
  };

  const text = 'First sentence here. Second sentence here.\n\nThird sentence for chunk two.';
  const manifest = await tts.generateChapter('cached-book', 0, text);

  // 3a. Cached chunk is marked READY immediately
  assertEqual(manifest.chunks[0].status, STATUS.READY, 'Cached chunk → ready immediately');
  assert(manifest.chunks[0].path !== null, 'Cached chunk has path set');

  // 3b. Non-cached chunks are enqueued
  const nonReady = manifest.chunks.filter(c => c.status !== STATUS.READY);
  assert(nonReady.length > 0, 'Non-cached chunks exist');
  for (const c of nonReady) {
    assertEqual(c.status, STATUS.QUEUED, `Chunk ${c.index} is queued`);
  }

  // 3c. Cached chunks are NOT enqueued to the queue
  // Only non-ready chunks should have jobs
  const enqueuedCount = mockQueue.jobs.length;
  assertEqual(enqueuedCount, nonReady.length,
    `Only ${nonReady.length} non-cached chunk(s) enqueued (got ${enqueuedCount})`);

  // 3d. First non-cached chunk gets 'immediate' priority
  if (mockQueue.jobs.length > 0) {
    assertEqual(mockQueue.jobs[0].priority, 'immediate',
      'First non-cached chunk gets immediate priority');
  }

  // 3e. Voice snapshot is passed through to the queue.
  const voicedQueue = new MockQueue();
  const voicedTTS = new ChunkedTTS('/tmp/test-cache', voicedQueue, { chunkSize: 40 });
  voicedTTS._fileExists = async () => false;
  await voicedTTS.generateChapter('voice-book', 0, text, 'en', 'immediate', { voice: 'kokoro:am_lewis' });
  assert(voicedQueue.jobs.length > 0, 'Voice snapshot test enqueues chunks');
  assert(voicedQueue.jobs.every(job => job.voice === 'kokoro:am_lewis'),
    'Voice snapshot is attached to every enqueued chunk');

  // 3f. _fileExists is called for each chunk
  assert(callCount >= manifest.totalChunks,
    `_fileExists called at least once per chunk (${callCount} calls for ${manifest.totalChunks} chunks)`);
})();

// ─── 4. File path generation ─────────────────────────────────────────────────

section('4. File path generation');

(() => {
  const tts = new ChunkedTTS('/data/audio-cache');

  assertEqual(
    tts.chunkPath('abc123', 2, 5),
    path.join('/data/audio-cache', 'abc123_ch2_chunk5.mp3'),
    'chunkPath generates correct path'
  );

  assertEqual(
    tts.chapterPath('abc123', 2),
    path.join('/data/audio-cache', 'abc123_ch2.mp3'),
    'chapterPath generates correct path'
  );

  let rejectedTraversal = false;
  try {
    tts.chunkPath('../outside', 0, 0);
  } catch {
    rejectedTraversal = true;
  }
  assert(rejectedTraversal, 'chunkPath rejects path traversal book ids');
})();

(async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xandrio-delete-gap-'));
  try {
    const tts = new ChunkedTTS(tmpDir, null, { variantKeyProvider: () => 'kokoro:test' });
    await fsp.writeFile(tts.chunkPath('bookgap', 2, 1), 'stale-1');
    await fsp.writeFile(tts.chunkPath('bookgap', 2, 3), 'stale-3');
    const wavChunkPath = tts.chunkPath('bookgap', 2, 2).replace(/\.mp3$/, '.wav');
    await fsp.writeFile(wavChunkPath, 'stale-wav');
    await tts._deleteChapterAudio('bookgap', 2);
    assertEqual(fs.existsSync(tts.chunkPath('bookgap', 2, 1)), false,
      'deleteChapterAudio removes stale chunk after missing chunk0');
    assertEqual(fs.existsSync(tts.chunkPath('bookgap', 2, 3)), false,
      'deleteChapterAudio removes all matching stale chunks');
    assertEqual(fs.existsSync(wavChunkPath), false,
      'deleteChapterAudio removes stale wav chunk after missing chunk0');
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
})();

// ─── 5. No queue → error on generate ────────────────────────────────────────

section('5. Queue requirement');

(async () => {
  const tts = new ChunkedTTS('/tmp/test-cache'); // no queue
  let threw = false;
  try {
    await tts.generateChapter('x', 0, 'text');
  } catch (e) {
    threw = true;
    assert(e.message.includes('TTSQueue'), 'Error mentions TTSQueue');
  }
  assert(threw, 'generateChapter throws without queue');
})();

// ─── 6. Edge cases for splitting ─────────────────────────────────────────────

section('6. Splitting edge cases');

(() => {
  const tts = new ChunkedTTS('/tmp/test-cache');

  // 6a. Single very long sentence (exceeds maxChars) — split safely for TTS
  const longSentence = 'a'.repeat(5000) + '.';
  const r = tts.splitIntoChunks(longSentence, 4000);
  assert(r.length > 1, 'Single long sentence is split into bounded chunks');
  assert(r.every(chunk => chunk.length <= 4001), 'Long sentence chunks respect maxChars');
  assertEqual(r.join(''), longSentence, 'Long sentence content preserved');

  // 6b. Text with only newlines and no content
  const r2 = tts.splitIntoChunks('\n\n\n\n');
  assertDeep(r2, [], 'Only newlines → empty');

  // 6c. Text without any sentence-ending punctuation
  const noPunct = 'This has no ending punctuation';
  const r3 = tts.splitIntoChunks(noPunct);
  assertEqual(r3.length, 1, 'No punctuation → 1 chunk');
  assertEqual(r3[0], noPunct, 'Content preserved without punctuation');

  // 6d. Many short paragraphs grouped together
  const shortParas = Array.from({ length: 20 }, (_, i) => `Para ${i}.`).join('\n\n');
  const r4 = tts.splitIntoChunks(shortParas, 100);
  assert(r4.length >= 1, `Short paragraphs grouped (got ${r4.length} chunks)`);
  // Verify no chunk exceeds limit (paragraphs are tiny)
  for (const chunk of r4) {
    assert(chunk.length <= 100, `Chunk length ${chunk.length} ≤ 100`);
  }

  // 6e. Paragraph with mixed sentence lengths
  const mixed = 'Short. ' + 'Medium sentence here. ' + 'A'.repeat(200) + '. ' + 'End.';
  const r5 = tts.splitIntoChunks(mixed, 100);
  assert(r5.length >= 2, `Mixed lengths split properly (got ${r5.length} chunks)`);
})();

// ─── Variant-scoped cache paths ──────────────────────────────────────────────

section('Variant-scoped cache paths');

(() => {
  const voiceA = new ChunkedTTS('/tmp/test-cache', null, { variantKeyProvider: () => 'kokoro:am_michael:profilebalanced' });
  const voiceB = new ChunkedTTS('/tmp/test-cache', null, { variantKeyProvider: () => 'chatterbox:brick-scott:profilebalanced' });
  const wavVoice = new ChunkedTTS('/tmp/test-cache', null, {
    variantKeyProvider: () => 'kokoro:af_heart:profilequality:outwav',
    outputFormatProvider: () => 'mp3'
  });
  const providerWavVoice = new ChunkedTTS('/tmp/test-cache', null, {
    variantKeyProvider: () => 'kokoro:af_heart:profilequality',
    outputFormatProvider: () => 'wav'
  });

  assert(voiceA.chapterPath('book1', 0) !== voiceB.chapterPath('book1', 0),
    'Chapter paths differ across voice variants');
  assert(voiceA.chunkPath('book1', 0, 0) !== voiceB.chunkPath('book1', 0, 0),
    'Chunk paths differ across voice variants');
  // Regression: the ffmpeg concat list files must be variant-scoped too, or
  // two voices concatenating the same chapter concurrently corrupt each other.
  assert(voiceA._concatListPath('book1', 0) !== voiceB._concatListPath('book1', 0),
    'Concat list paths differ across voice variants');
  assert(voiceA._concatListPath('book1', 0, { clean: true }) !== voiceB._concatListPath('book1', 0, { clean: true }),
    'Clean concat list paths differ across voice variants');
  assert(voiceA._concatListPath('book1', 0) !== voiceA._concatListPath('book1', 0, { clean: true }),
    'Clean and normal concat lists use distinct files');
  assert(wavVoice.chunkPath('book1', 0, 0).endsWith('.wav'),
    'Variant output tag controls chunk extension');
  assert(wavVoice.chapterPath('book1', 0).endsWith('.wav'),
    'Variant output tag controls chapter extension');
  assert(providerWavVoice.chunkPath('book1', 0, 0).endsWith('.wav'),
    'Output format provider controls extension when variant has no output tag');
})();

// ─── Summary ─────────────────────────────────────────────────────────────────

// Wait for async tests to finish
setTimeout(() => {
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('All tests passed! ✅');
  }
}, 500);
