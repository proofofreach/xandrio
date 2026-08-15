'use strict';

const assert = require('node:assert');
const fs = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const jsonStore = require('../lib/json-store');
const { createBookGuideJournal } = require('../lib/book-guide-journal');
const {
  certificationProvenance,
  CERTIFICATION_GATE_REQUIREMENTS,
  createBookGuideService,
  MAX_ATTEMPTS,
  REQUIRED_CERTIFICATION_GATES,
  publicJobStatus,
  publicProgress
} = require('../lib/book-guide-service');
const { createBookGuideStore } = require('../lib/book-guide-store');

const DIGEST = `sha256:${'a'.repeat(64)}`;
const EVIDENCE = [
  'Careful measurement reveals patterns in changing systems.',
  'Small feedback loops guide repeated improvements over time.',
  'Clear definitions prevent teams from solving different problems.',
  'Experiments work best when their expected result is recorded first.',
  'Limits matter because a method can fail outside its tested setting.'
];

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try { await fn(); passed++; console.log(`  PASS ${name}`); }
  catch (error) { failed++; console.error(`  FAIL ${name}: ${error.stack || error.message}`); }
}

function claimIds(prompt) {
  return [...new Set([...String(prompt).matchAll(/"id":"(c_[^"]+)"/g)].map(match => match[1]))];
}

function fakeProvider() {
  return {
    id: 'ppq-ai',
    generationErrorCode: null,
    compositionErrorCode: null,
    includeUnresolvedEvidence: false,
    verificationFailures: 0,
    extractedVerificationFailures: 0,
    failCurrentAttempt: false,
    failExtractedCurrentAttempt: 0,
    partialRepairResponses: 0,
    delayMs: 0,
    activeCalls: 0,
    maxActiveCalls: 0,
    calls: [],
    async hasCredentials() { return true; },
    normalizeBaseUrl: value => String(value),
    async inspect({ model }) { return { name: model, digest: DIGEST }; },
    async generate({ purpose, prompt, modelSnapshot, signal }) {
      this.activeCalls++;
      this.maxActiveCalls = Math.max(this.maxActiveCalls, this.activeCalls);
      try {
      if (this.delayMs) await new Promise(resolve => setTimeout(resolve, this.delayMs));
      this.calls.push({ purpose, model: modelSnapshot.name, prompt });
      if (String(prompt).startsWith('Return exactly one JSON object')) return { ok: true };
      if (this.generationErrorCode) {
        const error = new Error('provider returned malformed output');
        error.code = this.generationErrorCode;
        throw error;
      }
      if (purpose === 'composition' && this.compositionErrorCode) {
        const error = new Error('composition failed');
        error.code = this.compositionErrorCode;
        throw error;
      }
      if (signal?.aborted) {
        const error = new Error('cancelled');
        error.name = 'AbortError';
        throw error;
      }
      if (purpose === 'extraction') {
        return {
          claims: EVIDENCE.map((evidence, index) => ({
            statement: `Paraphrased grounded idea ${index + 1}.`, evidence, kind: index === 4 ? 'qualification' : 'claim'
          })).concat(this.includeUnresolvedEvidence ? [{
            statement: 'This candidate must be rejected.',
            evidence: 'Words that do not occur in the source passage.',
            kind: 'claim'
          }] : [])
        };
      }
      if (purpose === 'verification') {
        const ids = [...new Set([...String(prompt).matchAll(/"claimId":"([cg]_[^"]+)"/g)].map(match => match[1]))];
        return { verdicts: ids.map(claimId => ({
          claimId,
          supported: (!this.failCurrentAttempt || claimId.startsWith('c_')) &&
            (!this.failExtractedCurrentAttempt || !claimId.startsWith('c_') ||
              Number(claimId.split('_').at(-1)) >= this.failExtractedCurrentAttempt)
        })) };
      }
      if (purpose === 'composition' && String(prompt).startsWith('Repair only the rejected fields')) {
        this.failCurrentAttempt = this.verificationFailures > 0;
        if (this.failCurrentAttempt) this.verificationFailures--;
        const paths = [...new Set([...String(prompt).matchAll(/"path":"([^"]+)"/g)]
          .map(match => match[1]))];
        const returnedPaths = this.partialRepairResponses > 0 ? paths.slice(1) : paths;
        if (this.partialRepairResponses > 0) this.partialRepairResponses--;
        return { repairs: returnedPaths.map(path => ({ path, text: `Repaired grounded text for ${path}.` })) };
      }
      this.failCurrentAttempt = this.verificationFailures > 0;
      if (this.failCurrentAttempt) this.verificationFailures--;
      this.failExtractedCurrentAttempt = this.extractedVerificationFailures > 0 ? 3 : 0;
      if (this.failExtractedCurrentAttempt) this.extractedVerificationFailures--;
      const ids = claimIds(prompt);
      const cited = index => [ids[index % ids.length]];
      return {
        orientation: {
          thesis: { text: 'The book presents disciplined learning as a repeatable process.', claimIds: cited(0) },
          problem: { text: 'Unclear observation and scope lead to weak decisions.', claimIds: cited(1) },
          takeaways: Array.from({ length: 5 }, (_, index) => ({
            text: `Practical takeaway ${index + 1} in paraphrased form.`, claimIds: cited(index)
          })),
          bottomLine: { text: 'Test, define, measure, and respect limits.', claimIds: cited(4) }
        },
        coreIdeas: Array.from({ length: 5 }, (_, index) => ({
          title: `Core idea ${index + 1}`,
          claim: `Grounded claim ${index + 1}.`,
          howItWorks: `Mechanism ${index + 1} uses evidence and iteration.`,
          support: `The author supplies support for idea ${index + 1}.`,
          qualifications: index === 4 ? 'The tested setting limits the conclusion.' : '',
          implications: `Readers can inspect idea ${index + 1}.`,
          claimIds: cited(index)
        })),
        chapterMap: [{
          chapterIndex: 0,
          purpose: 'Establish the method and its limits.',
          contributions: ['Defines the core method.'],
          concepts: ['Measurement', 'Feedback'],
          claimIds: ids
        }],
        review: {
          questions: Array.from({ length: 8 }, (_, index) => ({
            question: `What does review question ${index + 1} test?`,
            answer: `It tests grounded idea ${(index % 5) + 1}.`,
            claimIds: cited(index)
          })),
          selfExplanationPrompts: ['Explain how measurement changes a decision.', 'Explain why scope limits matter.']
        },
        keyPassages: ids.slice(0, 3).map(claimId => ({ claimId }))
      };
      } finally {
        this.activeCalls--;
      }
    }
  };
}

async function waitIdle(service) {
  const deadline = Date.now() + 5000;
  while (!service.isIdle() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.strictEqual(service.isIdle(), true, 'service did not become idle');
}

async function harness({ initialSourceText = EVIDENCE.join(' '), segmentChars, modelConcurrency } = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'book-guide-service-'));
  const certificationFile = path.join(temp, 'certification.json');
  const provider = fakeProvider();
  const store = createBookGuideStore({
    artifactDir: path.join(temp, 'guides'),
    configFile: path.join(temp, 'config.json'),
    certificationFile,
    jsonStore
  });
  const journal = createBookGuideJournal({ filePath: path.join(temp, 'jobs.json'), jsonStore });
  let language = 'en';
  let category = 'unknown';
  let sourceText = initialSourceText;
  let chapterStructureKey = 'structure-1';
  const narrationLifecycle = [];
  const service = createBookGuideService({
    loadBook: async bookId => bookId === 'book_1'
      ? {
          id: bookId,
          path: '/book.epub',
          language,
          chapterStructureKey,
          studyGuideCategory: category,
          studyGuideCategorySetAt: category === 'nonfiction' ? '2026-08-13T11:00:00.000Z' : null
        }
      : null,
    getChapters: async () => [{ title: 'Chapter One', type: 'chapter', text: sourceText, estimatedDuration: 300 }],
    store,
    journal,
    provider,
    segmentChars,
    modelConcurrency,
    now: () => new Date('2026-08-13T12:00:00.000Z'),
    createId: (() => { let id = 0; return () => String(++id); })(),
    onArtifactPublished: async (bookId, artifact) => narrationLifecycle.push(['published', bookId, artifact.createdAt]),
    onArtifactRemoved: async bookId => narrationLifecycle.push(['removed', bookId]),
    log: { error() {}, warn() {} }
  });
  const certifiedProvenance = certificationProvenance({
    generator: { name: 'guide:1', digest: DIGEST },
    verifier: { name: 'verify:1', digest: DIGEST }
  });
  const certificationReport = {
    schemaVersion: 1,
    mode: 'offline',
    passed: true,
    provenance: certifiedProvenance,
    gates: REQUIRED_CERTIFICATION_GATES.map(name => {
      const [comparator, threshold] = CERTIFICATION_GATE_REQUIREMENTS[name];
      return { name, actual: threshold, threshold, comparator, passed: true };
    })
  };
  await jsonStore.save(certificationFile, certificationReport);
  return {
    temp, provider, service, store, journal, certificationFile, certificationReport, narrationLifecycle,
    setLanguage(value) { language = value; },
    setCategory(value) { category = value; },
    setChapterStructureKey(value) { chapterStructureKey = value; },
    setSourceText(value) { sourceText = value; }
  };
}

async function run() {
  const h = await harness();
  try {
    await test('normalizes durable job phases for the public UI contract', () => {
      assert.strictEqual(publicJobStatus({ status: 'pending' }), 'queued');
      assert.strictEqual(publicJobStatus({ status: 'running', phase: 'extracting' }), 'generating');
      assert.strictEqual(publicJobStatus({ status: 'running', phase: 'composing' }), 'generating');
      assert.strictEqual(publicJobStatus({ status: 'running', phase: 'verifying' }), 'verifying');
      assert.strictEqual(publicJobStatus({ status: 'failed' }), 'error');
      assert.deepStrictEqual(publicProgress({ status: 'running', phase: 'verifying', current: 1, total: 4 }), {
        current: 1,
        total: 4,
        percent: 25,
        stage: 'verifying',
        detail: 'Checking every material guide statement against cited source evidence.',
        reused: 0,
        attempt: 1,
        attemptsTotal: MAX_ATTEMPTS,
        elapsedSeconds: null,
        etaSeconds: null
      });
    });

    await test('reports disabled configuration explicitly', async () => {
      const result = await h.service.get('book_1');
      assert.strictEqual(result.feature.enabled, false);
      assert.strictEqual(result.status, 'unavailable');
    });

    await test('requires an explicit nonfiction tag stored on the title', async () => {
      await assert.rejects(h.service.configure({
        enabled: true,
        baseUrl: 'http://127.0.0.1:11434',
        generatorModel: 'guide:1',
        verifierModel: 'verify:1'
      }), error => error.code === 'BOOK_GUIDE_EXTERNAL_PROCESSING_ACKNOWLEDGEMENT_REQUIRED');
      const configured = await h.service.configure({
        enabled: true,
        externalProcessingAcknowledged: true,
        baseUrl: 'http://127.0.0.1:11434',
        generatorModel: 'guide:1',
        verifierModel: 'verify:1'
      });
      assert.strictEqual(configured.configured, true);
      assert.strictEqual(configured.certified, true);
      assert.strictEqual(configured.ready, true);
      const untagged = await h.service.get('book_1');
      assert.strictEqual(untagged.feature.enabled, true);
      assert.strictEqual(untagged.feature.ready, true);
      assert.strictEqual(untagged.eligibility.nonfictionTagged, false);
      assert.strictEqual(untagged.status, 'needs-classification');
      assert.strictEqual(untagged.message, 'Mark this title as nonfiction to enable its study guide.');
      await assert.rejects(h.service.start('book_1'), error => error.code === 'BOOK_GUIDE_NONFICTION_TAG_REQUIRED');
      h.setCategory('nonfiction');
    });

    await test('stores provider credentials separately and runs a bounded connection test', async () => {
      await h.service.configure({
        enabled: true,
        apiKey: 'test-secret',
        baseUrl: 'https://api.ppq.ai',
        generatorModel: 'guide:1',
        verifierModel: 'verify:1'
      });
      assert.strictEqual((await h.store.loadCredentials()).apiKey, 'test-secret');
      assert.strictEqual((await h.service.getConfig()).apiKey, undefined);
      assert.strictEqual((await h.service.getConfig()).externalProcessingAcknowledgedAt, '2026-08-13T12:00:00.000Z');
      assert.deepStrictEqual(await h.service.testConnection(), {
        ok: true,
        provider: 'ppq-ai',
        model: 'guide:1'
      });
    });

    await test('fails closed when the local certificate provenance does not match', async () => {
      const mismatched = structuredClone(h.certificationReport);
      mismatched.provenance.recipeHash = '0'.repeat(64);
      await jsonStore.save(h.certificationFile, mismatched);
      const config = await h.service.getConfig();
      assert.strictEqual(config.configured, true);
      assert.strictEqual(config.certified, false);
      assert.strictEqual(config.ready, false);
      assert.strictEqual(config.certificationReason, 'BOOK_GUIDE_CERTIFICATION_PROVENANCE_MISMATCH');
      await assert.rejects(
        h.service.start('book_1'),
        error => error.code === 'BOOK_GUIDE_CERTIFICATION_PROVENANCE_MISMATCH'
      );
      const evaluationConfig = await h.service.configure({
        enabled: true,
        allowUncertified: true,
        baseUrl: 'https://api.ppq.ai',
        generatorModel: 'guide:1',
        verifierModel: 'verify:1'
      });
      assert.strictEqual(evaluationConfig.ready, true);
      assert.strictEqual(evaluationConfig.certified, false);
      await jsonStore.save(h.certificationFile, h.certificationReport);
      await h.service.configure({
        enabled: true,
        allowUncertified: false,
        baseUrl: 'https://api.ppq.ai',
        generatorModel: 'guide:1',
        verifierModel: 'verify:1'
      });
    });

    await test('generates, verifies, and atomically publishes a shared guide', async () => {
      await h.service.start('book_1');
      await waitIdle(h.service);
      const result = await h.service.get('book_1');
      assert.strictEqual(result.status, 'ready');
      assert.strictEqual(result.artifact.scope.nonfictionConfirmed, true);
      assert.strictEqual(result.artifact.scope.externalProcessingConfirmed, true);
      assert.strictEqual(result.artifact.scope.certifiedAtGeneration, true);
      assert.strictEqual(result.artifact.verification.allClaimsChecked, true);
      assert(result.artifact.verification.materialItemCount > result.artifact.verification.extractedClaimCount);
      assert.strictEqual(
        result.artifact.verification.claimCount,
        result.artifact.verification.checkedItemCount
      );
      const verificationPrompts = h.provider.calls
        .filter(call => call.purpose === 'verification')
        .map(call => call.prompt).join('\n');
      assert(verificationPrompts.includes('"claimId":"g_0"'));
      assert(verificationPrompts.includes('The book presents disciplined learning as a repeatable process.'));
      assert(verificationPrompts.includes('It tests grounded idea 1.'));
      assert.strictEqual(result.artifact.models.generator.digest, DIGEST);
      assert.strictEqual(result.artifact.guide.review.questions.length, 8);
      assert.strictEqual(await h.store.readWork('book_1'), null, 'published work checkpoint must be removed');
      const anchorId = result.artifact.guide.coreIdeas[0].anchorIds[0];
      const context = await h.service.getAnchorContext('book_1', anchorId);
      assert(context.text.split(' ').length <= 18);
    });

    await test('retries failed semantic verification twice before publishing', async () => {
      const extractionCallsBefore = h.provider.calls.filter(call => call.purpose === 'extraction').length;
      h.provider.verificationFailures = 2;
      await h.service.start('book_1');
      await waitIdle(h.service);
      const result = await h.service.get('book_1');
      assert.strictEqual(result.artifact.verification.attempts, 3);
      assert.strictEqual(result.job.status, 'ready');
      const extractionCallsAfter = h.provider.calls.filter(call => call.purpose === 'extraction').length;
      assert.strictEqual(extractionCallsAfter - extractionCallsBefore, 1, 'grounded extraction must be reused');
    });

    await test('reuses verified claims when a new composition needs another quality pass', async () => {
      const callsBefore = h.provider.calls.length;
      h.provider.verificationFailures = 1;
      h.provider.partialRepairResponses = 1;
      await h.service.start('book_1');
      await waitIdle(h.service);
      const calls = h.provider.calls.slice(callsBefore);
      const secondComposition = calls.findIndex((call, index) => call.purpose === 'composition' &&
        calls.slice(0, index).some(prior => prior.purpose === 'composition'));
      assert(secondComposition >= 0, 'expected a second composition pass');
      const retriedVerification = calls.slice(secondComposition + 1)
        .filter(call => call.purpose === 'verification');
      assert(retriedVerification.length > 0);
      assert(calls[secondComposition].prompt.includes('orientation.thesis'),
        'the composer should receive the rejected guide field paths');
      assert(calls[secondComposition].prompt.startsWith('Repair only the rejected fields'),
        'the composer should patch rejected fields instead of regenerating the guide');
      assert(retriedVerification.every(call => !call.prompt.includes('"claimId":"c_')),
        'verified extracted claims should not be sent to the verifier again');
    });

    await test('runs independent model calls concurrently without changing final verification', async () => {
      const parallel = await harness({
        initialSourceText: Array.from({ length: 18 }, () => EVIDENCE.join(' ')).join(' '),
        segmentChars: 1000,
        modelConcurrency: 3
      });
      try {
        parallel.setCategory('nonfiction');
        await parallel.service.configure({
          enabled: true,
          externalProcessingAcknowledged: true,
          baseUrl: 'https://api.ppq.ai',
          generatorModel: 'guide:1',
          verifierModel: 'verify:1'
        });
        parallel.provider.delayMs = 20;
        parallel.provider.maxActiveCalls = 0;
        await parallel.service.start('book_1');
        await waitIdle(parallel.service);
        const result = await parallel.service.get('book_1');
        assert.strictEqual(result.status, 'ready');
        assert.strictEqual(result.artifact.verification.allClaimsChecked, true);
        assert(parallel.provider.maxActiveCalls >= 3, 'expected bounded parallel model calls');
        assert(parallel.provider.maxActiveCalls <= 3, 'model concurrency exceeded its bound');
      } finally {
        await fs.rm(parallel.temp, { recursive: true, force: true });
      }
    });

    await test('retains partially supported segments without repeating their extraction', async () => {
      const source = Array.from({ length: 10 }, () => EVIDENCE.join(' ')).join(' ');
      const selective = await harness({ initialSourceText: source, segmentChars: 1000 });
      try {
        selective.setCategory('nonfiction');
        await selective.service.configure({
          enabled: true,
          externalProcessingAcknowledged: true,
          baseUrl: 'https://api.ppq.ai',
          generatorModel: 'guide:1',
          verifierModel: 'verify:1'
        });
        selective.provider.extractedVerificationFailures = 1;
        const expectedSegments = selective.service.__test.splitChapterText(source, 1000).length;
        await selective.service.start('book_1');
        await waitIdle(selective.service);
        const result = await selective.service.get('book_1');
        const extractionCalls = selective.provider.calls.filter(call => call.purpose === 'extraction').length;
        assert.strictEqual(result.job.status, 'ready');
        assert(result.artifact.verification.attempts >= 2 && result.artifact.verification.attempts <= 3);
        assert.strictEqual(extractionCalls, expectedSegments, 'useful supported claims should remain checkpointed');
      } finally {
        await fs.rm(selective.temp, { recursive: true, force: true });
      }
    });

    await test('rejects an ungrounded candidate without discarding grounded claims from the segment', async () => {
      h.provider.includeUnresolvedEvidence = true;
      await h.service.start('book_1');
      await waitIdle(h.service);
      const result = await h.service.get('book_1');
      assert.strictEqual(result.status, 'ready');
      assert.strictEqual(result.artifact.verification.extractedClaimCount, EVIDENCE.length);
      h.provider.includeUnresolvedEvidence = false;
    });

    await test('normalizes job state and exposes the UI read contract', async () => {
      const result = await h.service.get('book_1');
      assert.strictEqual(result.featureEnabled, true);
      assert.strictEqual(result.canGenerate, true);
      assert.strictEqual(result.canManage, true);
      assert.strictEqual(result.status, 'ready');
      assert.strictEqual(result.generation.destination, 'https://api.ppq.ai');
      assert.strictEqual(result.feature.localOnly, false);
      assert.strictEqual(result.feature.externalProcessing, true);
      assert.strictEqual(result.generation.generatorModel, `guide:1@${DIGEST}`);
      assert.strictEqual(result.generation.verifierModel, `verify:1@${DIGEST}`);
    });

    await test('fails closed and preserves the prior verified artifact', async () => {
      const prior = await h.store.read('book_1');
      h.provider.verificationFailures = MAX_ATTEMPTS;
      await h.service.start('book_1');
      await waitIdle(h.service);
      const result = await h.service.get('book_1');
      assert.strictEqual(result.job.status, 'failed');
      assert.strictEqual(result.job.errorCode, 'BOOK_GUIDE_GROUNDING_FAILED');
      assert.deepStrictEqual(result.artifact, prior);
    });

    await test('preserves a specific provider failure and explains it to the UI', async () => {
      h.provider.generationErrorCode = 'BOOK_GUIDE_PROVIDER_RESPONSE_INVALID';
      await h.service.start('book_1');
      await waitIdle(h.service);
      const result = await h.service.get('book_1');
      assert.strictEqual(result.job.errorCode, 'BOOK_GUIDE_PROVIDER_RESPONSE_INVALID');
      assert.strictEqual(result.message, 'PPQ.ai repeatedly returned malformed model output. Try again or choose a different generator model.');
      h.provider.generationErrorCode = 'unexpected';
      await h.service.start('book_1');
      await waitIdle(h.service);
      const unexpected = await h.service.get('book_1');
      assert.strictEqual(unexpected.job.errorCode, 'BOOK_GUIDE_GENERATION_FAILED');
      assert.strictEqual(unexpected.message, 'Guide creation stopped before it could finish. Try again with the current model.');
      h.provider.generationErrorCode = null;
    });

    await test('resumes grounded extraction after a later phase fails', async () => {
      await h.store.removeWork('book_1');
      h.provider.compositionErrorCode = 'BOOK_GUIDE_PROVIDER_RESPONSE_INVALID';
      const beforeFirst = h.provider.calls.filter(call => call.purpose === 'extraction').length;
      await h.service.start('book_1');
      await waitIdle(h.service);
      const failed = await h.service.get('book_1');
      assert.strictEqual(failed.job.status, 'failed');
      assert(await h.store.readWork('book_1'), 'failed later phase should retain resumable grounded work');
      const afterFirst = h.provider.calls.filter(call => call.purpose === 'extraction').length;
      assert.strictEqual(afterFirst - beforeFirst, 1);

      h.provider.compositionErrorCode = null;
      await h.service.start('book_1');
      await waitIdle(h.service);
      const resumed = await h.service.get('book_1');
      const afterResume = h.provider.calls.filter(call => call.purpose === 'extraction').length;
      assert.strictEqual(resumed.job.status, 'ready');
      assert.strictEqual(afterResume, afterFirst, 'retry must not repeat persisted extraction');
      assert.strictEqual(resumed.artifact.verification.allClaimsChecked, true);
    });

    await test('marks an existing artifact stale when chapter structure changes', async () => {
      h.setChapterStructureKey('structure-2');
      const result = await h.service.get('book_1');
      assert.strictEqual(result.status, 'stale');
      assert.strictEqual(result.stale, true);
      h.setChapterStructureKey('structure-1');
    });

    await test('marks an existing artifact stale when the source fingerprint changes', async () => {
      h.setSourceText(`${EVIDENCE.join(' ')} New source material.`);
      const result = await h.service.get('book_1');
      assert.strictEqual(result.status, 'stale');
      assert.strictEqual(result.stale, true);
    });

    await test('blocks non-English generation at preflight', async () => {
      h.setLanguage('fr');
      await assert.rejects(
        h.service.start('book_1'),
        error => error.code === 'BOOK_GUIDE_LANGUAGE_UNSUPPORTED'
      );
    });

    await test('removes both artifact and durable job state', async () => {
      const removal = await h.service.removeBook('book_1');
      assert.strictEqual(removal.artifactRemoved, true);
      assert.strictEqual(await h.store.read('book_1'), null);
      assert.strictEqual(await h.journal.get('book_1'), null);
      assert(h.narrationLifecycle.some(event => event[0] === 'published' && event[1] === 'book_1'));
      assert.deepStrictEqual(h.narrationLifecycle.at(-1), ['removed', 'book_1']);
    });
  } finally {
    await fs.rm(h.temp, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

run();
