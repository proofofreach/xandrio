'use strict';

const assert = require('node:assert');
const {
  createOllamaBookGuideProvider,
  normalizeOllamaBaseUrl
} = require('../lib/book-guide-provider');

const DIGEST = `sha256:${'a'.repeat(64)}`;
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try { await fn(); passed++; console.log(`  PASS ${name}`); }
  catch (error) { failed++; console.error(`  FAIL ${name}: ${error.stack || error.message}`); }
}

function response(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

async function run() {
  await test('accepts only loopback Ollama origins', () => {
    assert.strictEqual(normalizeOllamaBaseUrl('http://127.0.0.1:11434'), 'http://127.0.0.1:11434');
    assert.throws(() => normalizeOllamaBaseUrl('https://ollama.example.com'), error => error.code === 'BOOK_GUIDE_PROVIDER_URL_INVALID');
    assert.throws(() => normalizeOllamaBaseUrl('http://127.0.0.1:11434/api'), error => error.code === 'BOOK_GUIDE_PROVIDER_URL_INVALID');
  });

  await test('pins and returns an exact installed model digest', async () => {
    const provider = createOllamaBookGuideProvider({
      fetchImpl: async url => {
        assert.strictEqual(new URL(url).pathname, '/api/tags');
        return response({ models: [{ name: 'guide:1', digest: DIGEST }] });
      }
    });
    assert.deepStrictEqual(
      await provider.inspect({ baseUrl: 'http://localhost:11434', model: 'guide:1' }),
      { name: 'guide:1', digest: DIGEST }
    );
  });

  await test('checks the digest again and forbids response model substitution', async () => {
    const paths = [];
    const provider = createOllamaBookGuideProvider({
      fetchImpl: async (url, options) => {
        const pathname = new URL(url).pathname;
        paths.push(pathname);
        if (pathname === '/api/tags') return response({ models: [{ name: 'guide:1', digest: DIGEST }] });
        const body = JSON.parse(options.body);
        assert.strictEqual(body.model, 'guide:1');
        assert.strictEqual(body.stream, false);
        return response({ model: 'guide:1', message: { content: '{"ok":true}' } });
      }
    });
    const result = await provider.generate({
      baseUrl: 'http://127.0.0.1:11434',
      modelSnapshot: { name: 'guide:1', digest: DIGEST },
      prompt: 'Return JSON.'
    });
    assert.deepStrictEqual(result, { ok: true });
    assert.deepStrictEqual(paths, ['/api/tags', '/api/chat']);
  });

  await test('fails closed when the installed digest changes', async () => {
    const provider = createOllamaBookGuideProvider({
      fetchImpl: async () => response({ models: [{ name: 'guide:1', digest: `sha256:${'b'.repeat(64)}` }] })
    });
    await assert.rejects(provider.generate({
      baseUrl: 'http://127.0.0.1:11434',
      modelSnapshot: { name: 'guide:1', digest: DIGEST },
      prompt: 'Return JSON.'
    }), error => error.code === 'BOOK_GUIDE_MODEL_CHANGED');
  });

  await test('fails closed when Ollama reports a substituted response model', async () => {
    const provider = createOllamaBookGuideProvider({
      fetchImpl: async url => new URL(url).pathname === '/api/tags'
        ? response({ models: [{ name: 'guide:1', digest: DIGEST }] })
        : response({ model: 'other:1', message: { content: '{}' } })
    });
    await assert.rejects(provider.generate({
      baseUrl: 'http://127.0.0.1:11434',
      modelSnapshot: { name: 'guide:1', digest: DIGEST },
      prompt: 'Return JSON.'
    }), error => error.code === 'BOOK_GUIDE_MODEL_SUBSTITUTED');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

run();
