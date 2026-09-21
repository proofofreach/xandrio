'use strict';

const POLICY_ID = 'vercel-typesafe-ai-jev-cascade-v1-p95';

function createJevGuideVerifier({ enabled = false, acknowledged = false,
  apiKey = process.env.AI_GATEWAY_API_KEY, timeoutMs = 2000, cooldownMs = 60000,
  evaluate = null } = {}) {
  const active = enabled === true && acknowledged === true && Boolean(apiKey);
  let tail = Promise.resolve();
  let pending = 0;
  async function acquire(signal) {
    if (pending >= 4) return null;
    pending++;
    const previous = tail;
    let resolveTicket;
    const ticket = new Promise(resolve => { resolveTicket = resolve; });
    tail = previous.then(() => ticket);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      pending--;
      resolveTicket();
    };
    let cancel;
    try {
      await new Promise((resolve, reject) => {
        cancel = () => reject(signal.reason || new Error('Cancelled'));
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
        previous.then(resolve);
      });
      return release;
    } catch (error) {
      // Keep the cancelled ticket in sequence until its predecessor exits.
      previous.then(release);
      throw error;
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }
  let unavailableUntil = 0;
  async function verify(items, { fallback, signal } = {}) {
    signal?.throwIfAborted();
    const started = Date.now();
    const finish = (result, counts) => ({ ...result, verificationMetrics: {
      jevAccepted: 0, jevRejected: 0, escalated: 0, fullFallback: 0, ...counts,
      elapsedMs: Date.now() - started
    } });
    const fallbackAll = async () => finish(await fallback(items), { fullFallback: items.length });
    if (!active || Date.now() < unavailableUntil || !items.length || items.length > 24) return fallbackAll();
    const evidence = [...new Set(items.map(item => item.evidence))];
    const state = {
      evidence: Object.fromEntries(evidence.map((text, i) => [`e${i}`, text])),
      claims: Object.fromEntries(items.map((item, i) => [`c${i}`, { statement: item.statement, evidenceId: `e${evidence.indexOf(item.evidence)}` }]))
    };
    // Keep an unexpectedly large request on the established verifier path.
    if (Buffer.byteLength(JSON.stringify(state)) > 180000) return fallbackAll();
    const questions = Object.fromEntries(items.map((item, i) => [`q${i}`, {
      type: 'boolean',
      instructions: `Does evidence.${state.claims[`c${i}`].evidenceId} support EVERY material detail of claims.c${i}.statement? Use only the provided evidence. Reject dropped qualifiers, causal inversion, scope inflation, entity conflation, and unsupported added details. A supported paraphrase need not repeat exact words.`,
      criteria: { true: 'All material details are supported by the supplied evidence, preserving qualifiers and scope.', false: 'Any material detail is contradicted or not established by the supplied evidence.' }
    }]));
    const release = await acquire(signal);
    if (!release) return fallbackAll();
    if (Date.now() < unavailableUntil) {
      release();
      signal?.throwIfAborted();
      return fallbackAll();
    }
    let timer;
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal?.aborted) controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    let probabilities;
    try {
      signal?.throwIfAborted();
      const operation = (async () => {
        const sdk = evaluate ? null : await import('ai');
        const run = evaluate || sdk.experimental_evaluate;
        return run({ model: sdk ? sdk.createGateway({ apiKey }).evaluationModel('typesafe-ai/jev') : undefined,
          state, questions, maxRetries: 0, abortSignal: controller.signal,
          providerOptions: { gateway: { only: ['typesafe-ai'] } } });
      })();
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('Jev deadline')); }, timeoutMs);
      });
      const cancelled = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('Jev cancelled')), { once: true }));
      const result = await Promise.race([operation, deadline, cancelled]);
      const route = result.providerMetadata?.gateway?.routing;
      if (route?.canonicalSlug !== 'typesafe-ai/jev' || route.finalProvider !== 'typesafe-ai' || route.modelAttemptCount !== 1 || route.totalProviderAttemptCount !== 1 ||
          Object.keys(result.answers || {}).length !== items.length) throw new Error('Invalid Jev route or answer count');
      probabilities = items.map((_, i) => {
        const answer = result.answers[`q${i}`];
        if (answer?.type !== 'boolean' || !Number.isFinite(answer.probability) || answer.probability < 0 || answer.probability > 1) throw new Error('Invalid Jev answer');
        return answer.probability;
      });
    } catch {
      if (!signal?.aborted) unavailableUntil = Date.now() + cooldownMs;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      release();
    }
    signal?.throwIfAborted();
    if (!probabilities) return fallbackAll();
    const uncertain = items.filter((_, i) => probabilities[i] > 0.05 && probabilities[i] < 0.95);
    const escalated = uncertain.length ? await fallback(uncertain) : { verdicts: [] };
    const verdicts = new Map((escalated?.verdicts || []).map(v => [v.claimId, v.supported === true]));
    return finish({ verdicts: items.map((item, i) => ({ claimId: item.id,
      supported: probabilities[i] >= 0.95 || (probabilities[i] > 0.05 && verdicts.get(item.id) === true) })) }, {
      jevAccepted: probabilities.filter(p => p >= 0.95).length, jevRejected: probabilities.filter(p => p <= 0.05).length, escalated: uncertain.length
    });
  }
  return { active, policyId: POLICY_ID, verify };
}
module.exports = { createJevGuideVerifier, POLICY_ID };
