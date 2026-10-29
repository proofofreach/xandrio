'use strict';

const crypto = require('node:crypto');
const { boundedJson, combinedSignal, providerError } = require('./book-guide-provider');

const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const OPENAI_MODELS = new Set(['gpt-5.6-luna', 'gpt-5.6-terra']);

function normalizeOpenAiBaseUrl(value = OPENAI_BASE_URL) {
  let url;
  try { url = new URL(String(value || OPENAI_BASE_URL)); } catch {}
  if (!url || url.origin !== 'https://api.openai.com' || url.username || url.password ||
      !['/v1', '/v1/'].includes(url.pathname) || url.search || url.hash) {
    throw providerError('Book Guides require the official OpenAI API destination', 'BOOK_GUIDE_PROVIDER_URL_INVALID', 400);
  }
  return OPENAI_BASE_URL;
}

function openAiDigest(model) {
  // Distinct from Codex/PPQ identities: no inherited certificates or checkpoints.
  return `sha256:${crypto.createHash('sha256').update(`openai-responses-tool-free-v1\0${model}`).digest('hex')}`;
}

function createOpenAiBookGuideProvider({ fetchImpl = globalThis.fetch, apiKey = process.env.OPENAI_API_KEY,
  getApiKey = null, timeoutMs = 180000, maxResponseBytes = 4 * 1024 * 1024 } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
  async function requireApiKey() {
    const value = String((getApiKey ? await getApiKey() : apiKey) || '').trim();
    if (!value) throw providerError('Configure an OpenAI API key in Study Guide settings', 'BOOK_GUIDE_PROVIDER_CREDENTIALS_MISSING', 409);
    return value;
  }
  async function inspect({ baseUrl, model, signal = null }) {
    normalizeOpenAiBaseUrl(baseUrl);
    if (signal?.aborted) throw providerError('OpenAI request cancelled', 'BOOK_GUIDE_PROVIDER_ABORTED', 503);
    if (!OPENAI_MODELS.has(model)) throw providerError('Choose a supported OpenAI guide model', 'BOOK_GUIDE_MODEL_REQUIRED', 400);
    await requireApiKey();
    return { name: model, digest: openAiDigest(model) };
  }
  async function generate({ baseUrl, modelSnapshot, prompt, purpose = 'generation', signal = null }) {
    const expected = await inspect({ baseUrl, model: modelSnapshot?.name, signal });
    if (modelSnapshot?.digest !== expected.digest) throw providerError('Configured OpenAI model identity changed', 'BOOK_GUIDE_MODEL_CHANGED', 409);
    const requestSignal = combinedSignal(signal, timeoutMs);
    let response;
    let data;
    try {
      response = await fetchImpl(`${OPENAI_BASE_URL}/responses`, {
        method: 'POST', redirect: 'error', signal: requestSignal,
        headers: { authorization: `Bearer ${await requireApiKey()}`, 'content-type': 'application/json' },
        // Stateless text inference only. There is no tool dispatcher, agent loop,
        // file input, conversation attachment, or model-controlled destination.
        body: JSON.stringify({ model: expected.name, input: String(prompt || ''),
          tools: [], tool_choice: 'none', store: false,
          text: { format: { type: 'json_object' } },
          reasoning: { effort: purpose === 'composition' ? 'medium' : 'low' },
          max_output_tokens: purpose === 'composition' ? 16000 : purpose === 'verification' ? 8000 : 4000 })
      });
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {});
        const code = [401, 403].includes(response.status) ? 'BOOK_GUIDE_PROVIDER_CREDENTIALS_INVALID'
          : response.status === 404 ? 'BOOK_GUIDE_MODEL_UNAVAILABLE' : 'BOOK_GUIDE_PROVIDER_UNAVAILABLE';
        throw providerError(`OpenAI request failed (${response.status})`, code, response.status === 404 ? 409 : 503);
      }
      data = await boundedJson(response, maxResponseBytes, 'OpenAI');
    } catch (error) {
      if (requestSignal.aborted || ['AbortError', 'TimeoutError'].includes(error?.name)) {
        throw providerError('OpenAI request timed out or was cancelled', 'BOOK_GUIDE_PROVIDER_ABORTED', 503);
      }
      if (error?.code?.startsWith('BOOK_GUIDE_')) throw error;
      throw providerError('OpenAI is unavailable', 'BOOK_GUIDE_PROVIDER_UNAVAILABLE', 503);
    }
    if (!data || data.model !== expected.name) throw providerError('OpenAI returned a different model', 'BOOK_GUIDE_MODEL_SUBSTITUTED', 409);
    const invalid = () => providerError('OpenAI returned an invalid text response', 'BOOK_GUIDE_PROVIDER_RESPONSE_INVALID', 502);
    if (data.status !== 'completed' || data.error || data.incomplete_details || !Array.isArray(data.output)) throw invalid();
    const texts = [];
    for (const item of data.output) {
      if (item?.type === 'reasoning') continue;
      if (item?.type !== 'message' || item.role !== 'assistant' || item.status !== 'completed' || !Array.isArray(item.content)) throw invalid();
      for (const content of item.content) {
        if (content?.type !== 'output_text' || typeof content.text !== 'string') throw invalid();
        texts.push(content.text);
      }
    }
    if (!texts.length) throw invalid();
    let result;
    try { result = JSON.parse(texts.join('')); } catch { throw invalid(); }
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw invalid();
    return result;
  }
  return {
    id: 'openai-api', label: 'OpenAI API', external: true, authMode: 'api-key',
    verificationPolicy: 'openai-responses-tool-free-v1',
    models: [{ id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', detail: 'Guide generation' },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', detail: 'Independent verifier' }],
    defaultGeneratorModel: 'gpt-5.6-luna', defaultVerifierModel: 'gpt-5.6-terra',
    generate, inspect, hasCredentials: async () => Boolean(await requireApiKey().catch(() => '')),
    normalizeBaseUrl: normalizeOpenAiBaseUrl
  };
}
module.exports = { OPENAI_BASE_URL, OPENAI_MODELS, createOpenAiBookGuideProvider, normalizeOpenAiBaseUrl, openAiDigest };
