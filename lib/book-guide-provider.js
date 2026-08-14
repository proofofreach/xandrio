'use strict';

const crypto = require('node:crypto');
const { Readable } = require('node:stream');

const PPQ_BASE_URL = 'https://api.ppq.ai';
const DEEPSEEK_FLASH_MODEL = 'deepseek/deepseek-v4-flash-0731';
const DEEPSEEK_PRO_MODEL = 'deepseek/deepseek-v4-pro-0813';
const GEMINI_FLASH_MODEL = 'gemini-3.7-flash';
const GLM_VERIFIER_MODEL = 'glm-5.2';
const PPQ_GUIDE_MODELS = new Set([
  GEMINI_FLASH_MODEL,
  DEEPSEEK_FLASH_MODEL,
  DEEPSEEK_PRO_MODEL,
  GLM_VERIFIER_MODEL
]);
const MODEL_DIGEST = /^sha256:[a-f0-9]{64}$/i;

function providerError(message, code, statusCode = 503) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function normalizePpqBaseUrl(value = PPQ_BASE_URL) {
  let url;
  try {
    url = new URL(String(value || PPQ_BASE_URL));
  } catch {
    throw providerError('PPQ.ai URL is invalid', 'BOOK_GUIDE_PROVIDER_URL_INVALID', 400);
  }
  if (url.origin !== PPQ_BASE_URL || url.username || url.password ||
      (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw providerError('Book Guides require the official PPQ.ai API origin', 'BOOK_GUIDE_PROVIDER_URL_INVALID', 400);
  }
  return PPQ_BASE_URL;
}

function routingDigest(model) {
  return `sha256:${crypto.createHash('sha256').update(`ppq.ai\0${model}`).digest('hex')}`;
}

function responseModelMatches(expected, actual) {
  const aliases = new Map([
    ['gemini-3.7-flash', 'google/gemini-3.7-flash']
  ]);
  return actual === expected || aliases.get(expected) === actual;
}

function combinedSignal(parent, timeoutMs) {
  const timeout = AbortSignal.timeout(Math.max(1, Number(timeoutMs) || 180000));
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

async function boundedJson(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw providerError('PPQ.ai response is too large', 'BOOK_GUIDE_PROVIDER_RESPONSE_INVALID', 502);
  }
  const chunks = [];
  let bytes = 0;
  if (response.body) {
    for await (const chunk of Readable.fromWeb(response.body)) {
      const data = Buffer.from(chunk);
      bytes += data.length;
      if (bytes > maxBytes) throw providerError('PPQ.ai response is too large', 'BOOK_GUIDE_PROVIDER_RESPONSE_INVALID', 502);
      chunks.push(data);
    }
  } else {
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > maxBytes) throw providerError('PPQ.ai response is too large', 'BOOK_GUIDE_PROVIDER_RESPONSE_INVALID', 502);
    chunks.push(data);
    bytes = data.length;
  }
  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
  } catch {
    throw providerError('PPQ.ai returned invalid JSON', 'BOOK_GUIDE_PROVIDER_RESPONSE_INVALID', 502);
  }
}

function parseStructuredContent(value) {
  const raw = String(value || '').trim();
  const unfenced = raw.startsWith('```')
    ? raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    : raw;
  try {
    return JSON.parse(unfenced);
  } catch {}

  // Some otherwise valid models wrap JSON mode output in a short preface or
  // postscript. Accept the last complete JSON object, but never repair or
  // guess malformed JSON.
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let parsed = null;
  for (let index = 0; index < raw.length; index++) {
    const character = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"' && depth > 0) {
      inString = true;
      continue;
    }
    if (character === '{') {
      if (depth === 0) start = index;
      depth++;
      continue;
    }
    if (character !== '}' || depth === 0) continue;
    depth--;
    if (depth !== 0 || start < 0) continue;
    try {
      const candidate = JSON.parse(raw.slice(start, index + 1));
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) parsed = candidate;
    } catch {}
    start = -1;
  }
  if (parsed) return parsed;
  throw providerError('The study-guide model did not return valid structured JSON', 'BOOK_GUIDE_PROVIDER_RESPONSE_INVALID', 502);
}

function createPpqBookGuideProvider({
  fetchImpl = globalThis.fetch,
  apiKey = process.env.PPQ_API_KEY,
  getApiKey = null,
  timeoutMs = 180000,
  maxResponseBytes = 4 * 1024 * 1024
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');

  async function requireApiKey() {
    const resolved = typeof getApiKey === 'function' ? await getApiKey() : apiKey;
    const value = String(resolved || '').trim();
    if (!value) throw providerError('PPQ_API_KEY is not configured', 'BOOK_GUIDE_PROVIDER_CREDENTIALS_MISSING', 409);
    return value;
  }

  async function inspect({ baseUrl = PPQ_BASE_URL, model, signal = null }) {
    normalizePpqBaseUrl(baseUrl);
    await requireApiKey();
    if (!PPQ_GUIDE_MODELS.has(model)) {
      throw providerError('Choose a supported study-guide model', 'BOOK_GUIDE_MODEL_REQUIRED', 400);
    }
    if (signal?.aborted) throw providerError('PPQ.ai request cancelled', 'BOOK_GUIDE_PROVIDER_ABORTED', 503);
    return { name: model, digest: routingDigest(model) };
  }

  async function generate({ baseUrl = PPQ_BASE_URL, modelSnapshot, prompt, purpose = 'generation', signal = null }) {
    const expected = await inspect({ baseUrl, model: modelSnapshot?.name, signal });
    if (!MODEL_DIGEST.test(String(modelSnapshot?.digest || '')) || modelSnapshot.digest !== expected.digest) {
      throw providerError('Configured PPQ.ai model identity changed', 'BOOK_GUIDE_MODEL_CHANGED', 409);
    }
    let response;
    try {
      response = await fetchImpl(`${PPQ_BASE_URL}/chat/completions`, {
        method: 'POST',
        redirect: 'error',
        signal: combinedSignal(signal, timeoutMs),
        headers: {
          authorization: `Bearer ${await requireApiKey()}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: expected.name,
          messages: [{ role: 'user', content: String(prompt || '') }],
          temperature: purpose === 'verification' ? 0 : 0.15,
          max_tokens: purpose === 'composition' ? 12000 : purpose === 'verification' ? 1500 : 1800,
          reasoning: { effort: purpose === 'composition' ? 'medium' : 'low' },
          response_format: { type: 'json_object' },
          provider: { zdr: true }
        })
      });
    } catch (error) {
      if (error.name === 'AbortError' || error.name === 'TimeoutError') {
        throw providerError('PPQ.ai request timed out or was cancelled', 'BOOK_GUIDE_PROVIDER_ABORTED', 503);
      }
      throw providerError('PPQ.ai is unavailable', 'BOOK_GUIDE_PROVIDER_UNAVAILABLE', 503);
    }
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      const code = response.status === 401 || response.status === 403
        ? 'BOOK_GUIDE_PROVIDER_CREDENTIALS_INVALID'
        : response.status === 402
          ? 'BOOK_GUIDE_PROVIDER_FUNDS_REQUIRED'
          : response.status === 404
            ? 'BOOK_GUIDE_MODEL_UNAVAILABLE'
          : 'BOOK_GUIDE_PROVIDER_UNAVAILABLE';
      throw providerError(`PPQ.ai request failed (${response.status})`, code,
        response.status === 402 || response.status === 404 ? 409 : 503);
    }
    const data = await boundedJson(response, maxResponseBytes);
    if (data.model && !responseModelMatches(expected.name, data.model)) {
      const error = providerError('PPQ.ai substituted a different model', 'BOOK_GUIDE_MODEL_SUBSTITUTED', 409);
      error.actualModel = String(data.model).slice(0, 200);
      throw error;
    }
    return parseStructuredContent(data.choices?.[0]?.message?.content);
  }

  return {
    id: 'ppq-ai',
    external: true,
    generate,
    inspect,
    hasCredentials: async () => Boolean(await requireApiKey().catch(() => '')),
    normalizeBaseUrl: normalizePpqBaseUrl
  };
}

module.exports = {
  DEEPSEEK_FLASH_MODEL,
  DEEPSEEK_PRO_MODEL,
  GEMINI_FLASH_MODEL,
  GLM_VERIFIER_MODEL,
  MODEL_DIGEST,
  PPQ_BASE_URL,
  PPQ_GUIDE_MODELS,
  createPpqBookGuideProvider,
  normalizePpqBaseUrl,
  parseStructuredContent,
  providerError,
  responseModelMatches,
  routingDigest
};
