'use strict';

const POLICY_ID = 'vercel-typesafe-ai-jev-cascade-v1-p95';

function createJevGuideVerifier({ enabled = false, acknowledged = false,
  apiKey = process.env.AI_GATEWAY_API_KEY, timeoutMs = 2000, cooldownMs = 60000,
  evaluate = null } = {}) {
  const active = enabled === true && acknowledged === true && Boolean(apiKey);
  let busy = false;
  let unavailableUntil = 0;
  async function verify(items, { fallback, signal } = {}) {
    signal?.throwIfAborted();
    const started = Date.now();
    const finish = (result, counts) => ({ ...result, verificationMetrics: {
      jevAccepted: 0, jevRejected: 0, escalated: 0, fullFallback: 0, ...counts,
      elapsedMs: Date.now() - started
    } });
    const fallbackAll = async () => finish(await fallback(items), { fullFallback: items.length });
    if (!active || busy || Date.now() < unavailableUntil || !items.length || items.length > 24) return fallbackAll();
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
    busy = true;
    let timer;
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    let probabilities;
    try {
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
      unavailableUntil = Date.now() + cooldownMs;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      busy = false;
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
