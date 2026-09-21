'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { cases } = require('./fixtures/processing-judgments');
const { baseline, requestFor, validateAnswer, summarize, run, MODEL } = require('../scripts/benchmark-processing-judgments');

function responseFor(request, choice, confidence = 0.99, inputTokens = 100) {
  const keys = Object.keys(request.questions.decision.criteria);
  return { model: MODEL, usage: { input_tokens: inputTokens }, answers: { decision: {
    type: 'choice', choice, confidence,
    probabilities: Object.fromEntries(keys.map(key => [key, key === choice ? 1 : 0]))
  } } };
}
test('all five categories have disjoint development/challenge families and valid labels', () => {
  assert.equal(new Set(cases.map(c => c.id)).size, cases.length);
  assert.equal(new Set(cases.map(c => c.category)).size, 5);
  const splitByFamily = new Map();
  for (const item of cases) {
    const group = `${item.category}/${item.family}`;
    if (splitByFamily.has(group)) assert.equal(splitByFamily.get(group), item.split);
    splitByFamily.set(group, item.split);
    assert.ok(item.expected in requestFor(item).questions.decision.criteria);
    assert.equal(typeof baseline(item), 'string');
  }
});
test('requests do not depend on expected labels, case IDs, splits or rationales', () => {
  for (const item of cases) {
    assert.deepEqual(requestFor(item), requestFor({ ...item, id: 'SECRET_LABEL', expected: 'SECRET_LABEL', rationale: 'SECRET_LABEL', split: 'SECRET_LABEL', family: 'SECRET_LABEL' }));
  }
});
test('response validation rejects substitution, malformed distributions and unbounded answers', () => {
  const request = requestFor(cases[0]);
  const data = responseFor(request, cases[0].expected);
  assert.equal(validateAnswer(data, request).choice, cases[0].expected);
  assert.throws(() => validateAnswer({ ...data, model: 'jev-latest' }, request));
  for (const patch of [{ confidence: NaN }, { confidence: 2 }, { choice: 'invented' }, { probabilities: {} }]) {
    assert.throws(() => validateAnswer({ ...data, answers: { decision: { ...data.answers.decision, ...patch } } }, request));
  }
});
test('baseline mode never makes a network call or reports a model result', async () => {
  const report = await run({ dataset: cases.slice(0, 2), fetchImpl: () => { throw new Error('Network forbidden'); } });
  assert.equal(report.requestsSent, 0);
  assert.equal(report.liveComparisonAvailable, false);
  assert.equal(report.summary['classification/all'].hybridCorrect, null);
});
test('missing credentials and insufficient preflight budget fail before requests', async () => {
  let calls = 0;
  const fetchImpl = () => { calls++; throw new Error('Unexpected request'); };
  await assert.rejects(run({ live: true, apiKey: '', fetchImpl, dataset: cases.slice(0, 1) }), /API_KEY/);
  await assert.rejects(run({ live: true, apiKey: 'test-secret', maxUsd: 1e-10, fetchImpl, dataset: cases.slice(0, 1) }), /exceeds/);
  assert.equal(calls, 0);
});
test('low confidence retains the real heuristic and records usage without exposing the key', async () => {
  const item = cases[0];
  const report = await run({ live: true, apiKey: 'test-secret', dataset: [item], fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(options.redirect, 'error');
    const request = JSON.parse(options.body);
    return { ok: true, json: async () => responseFor(request, 'content', 0.2) };
  } });
  assert.equal(report.rows[0].hybrid, baseline(item));
  assert.equal(report.rows[0].accepted, false);
  assert.equal(report.billedInputTokens, 100);
  assert.equal(report.completed, true);
  assert.ok(!JSON.stringify(report).includes('test-secret'));
});
test('failed paid attempt is counted, never retried, and stops later network calls', async () => {
  let calls = 0;
  const report = await run({ live: true, apiKey: 'test-secret', dataset: cases.slice(0, 3), fetchImpl: async () => {
    calls++; return { ok: false, status: 429 };
  } });
  assert.equal(calls, 1);
  assert.equal(report.unknownUsageAttempts, 1);
  assert.equal(report.completed, false);
  assert.equal(report.rows[1].jev.status, 'not-run');
  assert.equal(report.rows[0].hybrid, report.rows[0].baseline);
});
test('unknown usage stops spending even after a valid response', async () => {
  let calls = 0;
  const report = await run({ live: true, apiKey: 'test-secret', dataset: cases.slice(0, 2), fetchImpl: async (url, options) => {
    calls++;
    const data = responseFor(JSON.parse(options.body), cases[0].expected);
    delete data.usage;
    return { ok: true, json: async () => data };
  } });
  assert.equal(calls, 1);
  assert.equal(report.unknownUsageAttempts, 1);
  assert.equal(report.completed, false);
});
test('aggregate includes regressions, not only successful model responses', () => {
  const rows = [
    { category: 'cleanup', split: 'challenge', expected: 'keep', baseline: 'keep', hybrid: 'remove', accepted: true, baselineMs: 1, jev: { status: 'ok', attempted: true, choice: 'remove', elapsedMs: 20 } },
    { category: 'cleanup', split: 'challenge', expected: 'remove', baseline: 'keep', hybrid: 'keep', accepted: false, baselineMs: 1, jev: { status: 'error', attempted: true, elapsedMs: 40 } }
  ];
  const stats = summarize(rows)['cleanup/all'];
  assert.equal(stats.n, 2);
  assert.equal(stats.modelObserved, 1);
  assert.equal(stats.regressions, 1);
  assert.equal(stats.harmfulOverrides, 1);
  assert.equal(stats.hybridCorrect, 0);
  assert.equal(stats.liveP95Ms, 40);
});

test('a final-case accounting failure cannot produce a completed benchmark', async () => {
  const item = cases[0];
  const report = await run({ live: true, apiKey: 'test-secret', dataset: [item], fetchImpl: async (url, options) => {
    const data = responseFor(JSON.parse(options.body), item.expected);
    delete data.usage;
    return { ok: true, json: async () => data };
  } });
  assert.equal(report.rows[0].jev.status, 'ok');
  assert.equal(report.completed, false);
  assert.equal(report.liveComparisonAvailable, false);
  assert.equal(report.potentialUntrackedOrOverGuardAttempt, true);
});

test('category interleaving attempts each category early', async () => {
  const chosen = cases.filter(item => ['classification', 'cleanup'].includes(item.category)).slice(0, 14);
  const report = await run({ dataset: chosen });
  assert.deepEqual(report.rows.slice(0, 2).map(row => row.category), ['classification', 'cleanup']);
});

test('Gateway route records actual cost and never presents an alias as a pinned model', async () => {
  const item = cases[0];
  const report = await run({ live: true, provider: 'vercel', apiKey: 'test-secret', dataset: [item],
    fetchImpl: () => { throw new Error('Direct transport forbidden'); },
    evaluateImpl: async request => {
      assert.equal(request.model, 'typesafe-ai/jev');
      return { ...responseFor(request, item.expected), model: request.model,
        gateway: { costUsd: 0, finalProvider: 'typesafe-ai', modelAttemptCount: 1, totalProviderAttemptCount: 1 } };
    }
  });
  assert.equal(report.completed, true);
  assert.equal(report.modelVersionPinned, false);
  assert.equal(report.gatewayReportedCostUsd, 0);
  assert.equal(report.rows[0].accepted, true);
});

test('Gateway missing costs or extra provider attempts cannot complete a run', async () => {
  for (const gateway of [
    { costUsd: null, finalProvider: 'typesafe-ai', modelAttemptCount: 1, totalProviderAttemptCount: 1 },
    { costUsd: 0, finalProvider: 'typesafe-ai', modelAttemptCount: 1, totalProviderAttemptCount: 2 }
  ]) {
    const report = await run({ live: true, provider: 'vercel', apiKey: 'test-secret', dataset: [cases[0]],
      evaluateImpl: async request => ({ ...responseFor(request, cases[0].expected), model: request.model, gateway })
    });
    assert.equal(report.completed, false);
    assert.equal(report.potentialUntrackedOrOverGuardAttempt, true);
  }
});
