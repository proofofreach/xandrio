'use strict';

const assert = require('node:assert');
const {
  DEEPSEEK_FLASH_MODEL,
  DEEPSEEK_PRO_MODEL,
  GLM_VERIFIER_MODEL,
  PPQ_BASE_URL,
  createPpqBookGuideProvider,
  normalizePpqBaseUrl,
  routingDigest
} = require('../lib/book-guide-provider');

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
  await test('accepts only the official PPQ.ai API origin', () => {
    assert.strictEqual(normalizePpqBaseUrl(PPQ_BASE_URL), PPQ_BASE_URL);
    assert.throws(() => normalizePpqBaseUrl('https://example.com'), error => error.code === 'BOOK_GUIDE_PROVIDER_URL_INVALID');
    assert.throws(() => normalizePpqBaseUrl(`${PPQ_BASE_URL}/chat`), error => error.code === 'BOOK_GUIDE_PROVIDER_URL_INVALID');
  });

  await test('requires a write-only provider credential', async () => {
    const provider = createPpqBookGuideProvider({ apiKey: '' });
    await assert.rejects(
      provider.inspect({ model: DEEPSEEK_FLASH_MODEL }),
      error => error.code === 'BOOK_GUIDE_PROVIDER_CREDENTIALS_MISSING'
    );
  });

  await test('pins supported PPQ model routes deterministically', async () => {
    const provider = createPpqBookGuideProvider({ apiKey: 'test-secret' });
    assert.deepStrictEqual(await provider.inspect({ model: DEEPSEEK_FLASH_MODEL }), {
      name: DEEPSEEK_FLASH_MODEL,
      digest: routingDigest(DEEPSEEK_FLASH_MODEL)
    });
    assert.strictEqual((await provider.inspect({ model: DEEPSEEK_PRO_MODEL })).name, DEEPSEEK_PRO_MODEL);
    assert.strictEqual((await provider.inspect({ model: GLM_VERIFIER_MODEL })).name, GLM_VERIFIER_MODEL);
    await assert.rejects(provider.inspect({ model: 'unknown/model' }), error => error.code === 'BOOK_GUIDE_MODEL_REQUIRED');
  });

  await test('uses the OpenAI-compatible chat endpoint with auth, JSON mode, and ZDR', async () => {
    let request;
    const provider = createPpqBookGuideProvider({
      apiKey: 'test-secret',
      fetchImpl: async (url, options) => {
        request = { url, options, body: JSON.parse(options.body) };
        return response({
          model: DEEPSEEK_FLASH_MODEL,
          choices: [{ message: { content: '{"ok":true}' } }]
        });
      }
    });
    const result = await provider.generate({
      modelSnapshot: { name: DEEPSEEK_FLASH_MODEL, digest: routingDigest(DEEPSEEK_FLASH_MODEL) },
      prompt: 'Return JSON.',
      purpose: 'verification'
    });
    assert.deepStrictEqual(result, { ok: true });
    assert.strictEqual(request.url, `${PPQ_BASE_URL}/chat/completions`);
    assert.strictEqual(request.options.headers.authorization, 'Bearer test-secret');
    assert.strictEqual(request.body.model, DEEPSEEK_FLASH_MODEL);
    assert.deepStrictEqual(request.body.response_format, { type: 'json_object' });
    assert.deepStrictEqual(request.body.provider, { zdr: true });
    assert.strictEqual(request.body.temperature, 0);
  });

  await test('accepts fenced structured JSON', async () => {
    const provider = createPpqBookGuideProvider({
      apiKey: 'test-secret',
      fetchImpl: async () => response({ choices: [{ message: { content: '```json\n{"ok":true}\n```' } }] })
    });
    assert.deepStrictEqual(await provider.generate({
      modelSnapshot: { name: GLM_VERIFIER_MODEL, digest: routingDigest(GLM_VERIFIER_MODEL) },
      prompt: 'Return JSON.'
    }), { ok: true });
  });

  await test('fails closed on response model substitution', async () => {
    const provider = createPpqBookGuideProvider({
      apiKey: 'test-secret',
      fetchImpl: async () => response({ model: GLM_VERIFIER_MODEL, choices: [{ message: { content: '{}' } }] })
    });
    await assert.rejects(provider.generate({
      modelSnapshot: { name: DEEPSEEK_FLASH_MODEL, digest: routingDigest(DEEPSEEK_FLASH_MODEL) },
      prompt: 'Return JSON.'
    }), error => error.code === 'BOOK_GUIDE_MODEL_SUBSTITUTED');
  });

  await test('maps rejected credentials and insufficient credit safely', async () => {
    for (const [status, code] of [[401, 'BOOK_GUIDE_PROVIDER_CREDENTIALS_INVALID'], [402, 'BOOK_GUIDE_PROVIDER_FUNDS_REQUIRED']]) {
      const provider = createPpqBookGuideProvider({ apiKey: 'test-secret', fetchImpl: async () => response({}, status) });
      await assert.rejects(provider.generate({
        modelSnapshot: { name: DEEPSEEK_FLASH_MODEL, digest: routingDigest(DEEPSEEK_FLASH_MODEL) },
        prompt: 'Return JSON.'
      }), error => error.code === code && !error.message.includes('test-secret'));
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

run();
