'use strict';

const { Readable } = require('node:stream');

const MODEL_DIGEST = /^sha256:[a-f0-9]{64}$/i;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function providerError(message, code, statusCode = 503) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function normalizeOllamaBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw providerError('Ollama URL is invalid', 'BOOK_GUIDE_PROVIDER_URL_INVALID', 400);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      !LOOPBACK_HOSTS.has(url.hostname) || (url.pathname !== '/' && url.pathname !== '') ||
      url.search || url.hash) {
    throw providerError('Ollama must use a loopback HTTP endpoint', 'BOOK_GUIDE_PROVIDER_URL_INVALID', 400);
  }
  return url.origin;
}

function combinedSignal(parent, timeoutMs) {
  const timeout = AbortSignal.timeout(Math.max(1, Number(timeoutMs) || 120000));
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

async function boundedJson(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw providerError('Ollama response is too large', 'BOOK_GUIDE_PROVIDER_RESPONSE_INVALID', 502);
  }
  if (!response.body) {
    const raw = Buffer.from(await response.arrayBuffer());
    if (raw.length > maxBytes) throw providerError('Ollama response is too large', 'BOOK_GUIDE_PROVIDER_RESPONSE_INVALID', 502);
    return JSON.parse(raw.toString('utf8'));
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of Readable.fromWeb(response.body)) {
    const data = Buffer.from(chunk);
    bytes += data.length;
    if (bytes > maxBytes) throw providerError('Ollama response is too large', 'BOOK_GUIDE_PROVIDER_RESPONSE_INVALID', 502);
    chunks.push(data);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
  } catch {
    throw providerError('Ollama returned invalid JSON', 'BOOK_GUIDE_PROVIDER_RESPONSE_INVALID', 502);
  }
}

function createOllamaBookGuideProvider({
  fetchImpl = globalThis.fetch,
  timeoutMs = 120000,
  maxResponseBytes = 4 * 1024 * 1024
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');

  async function request(baseUrl, pathname, options = {}) {
    const origin = normalizeOllamaBaseUrl(baseUrl);
    let response;
    try {
      response = await fetchImpl(new URL(pathname, `${origin}/`), {
        ...options,
        redirect: 'error',
        signal: combinedSignal(options.signal, timeoutMs)
      });
    } catch (error) {
      if (error.name === 'AbortError' || error.name === 'TimeoutError') {
        throw providerError('Ollama request timed out or was cancelled', 'BOOK_GUIDE_PROVIDER_ABORTED', 503);
      }
      throw providerError('Ollama is unavailable', 'BOOK_GUIDE_PROVIDER_UNAVAILABLE', 503);
    }
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      throw providerError(`Ollama request failed (${response.status})`, 'BOOK_GUIDE_PROVIDER_UNAVAILABLE', 503);
    }
    return boundedJson(response, maxResponseBytes);
  }

  async function inspect({ baseUrl, model, signal = null }) {
    if (typeof model !== 'string' || !model.trim()) {
      throw providerError('An exact Ollama model name is required', 'BOOK_GUIDE_MODEL_REQUIRED', 400);
    }
    const data = await request(baseUrl, '/api/tags', { method: 'GET', signal });
    const exact = Array.isArray(data.models) && data.models.find(candidate =>
      candidate?.name === model || candidate?.model === model
    );
    if (!exact) throw providerError('Configured Ollama model is not installed', 'BOOK_GUIDE_MODEL_UNAVAILABLE', 409);
    if (!MODEL_DIGEST.test(String(exact.digest || ''))) {
      throw providerError('Ollama did not report an exact model digest', 'BOOK_GUIDE_MODEL_DIGEST_INVALID', 409);
    }
    return { name: model, digest: exact.digest };
  }

  async function generate({ baseUrl, modelSnapshot, prompt, purpose = 'generation', signal = null }) {
    if (!modelSnapshot?.name || !MODEL_DIGEST.test(String(modelSnapshot.digest || ''))) {
      throw providerError('Pinned model snapshot is invalid', 'BOOK_GUIDE_MODEL_DIGEST_INVALID', 409);
    }
    const installed = await inspect({ baseUrl, model: modelSnapshot.name, signal });
    if (installed.digest !== modelSnapshot.digest) {
      throw providerError('Configured Ollama model digest changed', 'BOOK_GUIDE_MODEL_CHANGED', 409);
    }
    const data = await request(baseUrl, '/api/chat', {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: modelSnapshot.name,
        stream: false,
        format: 'json',
        options: { temperature: purpose === 'verification' ? 0 : 0.15 },
        messages: [{ role: 'user', content: String(prompt || '') }]
      })
    });
    if (data.model !== modelSnapshot.name) {
      throw providerError('Ollama substituted a different model', 'BOOK_GUIDE_MODEL_SUBSTITUTED', 409);
    }
    const content = data.message?.content;
    if (typeof content !== 'string') {
      throw providerError('Ollama response did not contain structured output', 'BOOK_GUIDE_PROVIDER_RESPONSE_INVALID', 502);
    }
    try {
      return JSON.parse(content);
    } catch {
      throw providerError('Ollama structured output was invalid', 'BOOK_GUIDE_PROVIDER_RESPONSE_INVALID', 502);
    }
  }

  return { generate, inspect, normalizeBaseUrl: normalizeOllamaBaseUrl };
}

module.exports = {
  LOOPBACK_HOSTS,
  MODEL_DIGEST,
  createOllamaBookGuideProvider,
  normalizeOllamaBaseUrl,
  providerError
};
