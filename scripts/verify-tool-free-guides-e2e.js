'use strict';
// Offline route -> service -> real HTTP model fixture -> artifact regression.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const express = require('express');
const { createBookGuideStore } = require('../lib/book-guide-store');
const { createBookGuideJournal } = require('../lib/book-guide-journal');
const { createBookGuideService } = require('../lib/book-guide-service');
const { registerBookGuideRoutes } = require('../lib/routes/book-guide-routes');
const output = path.resolve(process.argv[2] || 'output/tool-free-guides');
const checks = [];
async function check(name, fn) {
  try { await fn(); checks.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (e) { checks.push({ name, passed: false, error: e.stack }); console.error(`FAIL ${name}: ${e.message}`); }
}
const evidence = [
  'Careful measurement reveals patterns in changing systems.',
  'Small feedback loops guide repeated improvements over time.',
  'Clear definitions prevent teams from solving different problems.',
  'Experiments work best when their expected result is recorded first.',
  'Limits matter because a method can fail outside its tested setting.'
];
function fixture(prompt) {
  if (prompt.startsWith('Return exactly one JSON object')) return { ok: true };
  if (prompt.includes('"claimId":')) return { verdicts: [...new Set([...prompt.matchAll(/"claimId":"([cg]_[^"]+)"/g)].map(m => m[1]))].map(claimId => ({ claimId, supported: true })) };
  const ids = [...new Set([...prompt.matchAll(/"id":"(c_[^"]+)"/g)].map(m => m[1]))];
  if (!ids.length) return { claims: evidence.map((text, i) => ({ statement: `Grounded idea ${i + 1}.`, evidence: text, kind: 'claim' })) };
  const cite = i => [ids[i % ids.length]];
  const material = i => ({ text: `Paraphrased teaching point ${i + 1}.`, claimIds: cite(i) });
  return {
    orientation: { thesis: material(0), problem: material(1), takeaways: Array.from({ length: 5 }, (_, i) => material(i)), bottomLine: material(4) },
    coreIdeas: Array.from({ length: 5 }, (_, i) => ({ title: `Idea ${i + 1}`, claim: `Grounded claim ${i + 1}.`, howItWorks: 'Measurement enables learning.', support: 'The author supplies evidence.', qualifications: 'Scope limits apply.', implications: 'Inspect the evidence.', claimIds: cite(i) })),
    chapterMap: [{ chapterIndex: 0, purpose: 'Establish a learning method.', contributions: ['Defines the method.'], concepts: ['Measurement'], claimIds: ids }],
    review: { questions: Array.from({ length: 8 }, (_, i) => ({ question: `What does idea ${i + 1} test?`, answer: `It tests grounded idea ${(i % 5) + 1}.`, claimIds: cite(i) })), selfExplanationPrompts: ['Explain how measurement improves decisions.', 'Explain the scope limits.'] },
    keyPassages: ids.slice(0, 3).map(claimId => ({ claimId }))
  };
}
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
async function main() {
  await fs.mkdir(output, { recursive: true });
  await check('server no longer wires an ambient Codex subprocess', async () => {
    const source = await fs.readFile(path.join(__dirname, '../server.js'), 'utf8');
    assert(!source.includes('createCodexBookGuideProvider'));
  });
  await check('settings use active provider labels, destination and supported default pair', async () => {
    const source = await fs.readFile(path.join(__dirname, '../public/js/views/settings.js'), 'utf8');
    assert(source.includes('config.providerLabel'));
    assert(source.includes('baseUrl: bookGuideConfig.providerBaseUrl'));
    assert(source.includes('config.defaultGeneratorModel') && source.includes('config.defaultVerifierModel'));
    assert(source.includes('config.providerMatches && config.externalProcessingAcknowledgedAt'));
  });
  let api;
  try { api = require('../lib/book-guide-openai-provider'); }
  catch (e) {
    await check('tool-free provider is available instead of the exec runner', () => { throw e; });
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ checks, node: process.version }, null, 2));
    process.exitCode = 1; return;
  }
  const { createOpenAiBookGuideProvider, openAiDigest, OPENAI_BASE_URL } = api;
  const { createConfiguredBookGuideProvider } = require('../lib/book-guide-provider-config');
  const requests = [];
  let mode = 'ok';
  let redirectHits = 0;
  const modelServer = http.createServer(async (req, res) => {
    if (req.url === '/redirect-target') { redirectHits++; res.end('{}'); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    requests.push({ url: req.url, authorization: req.headers.authorization, body });
    const text = JSON.stringify(fixture(body.input));
    const data = { status: 'completed', model: body.model, output: [{ type: 'reasoning', summary: [] }, { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }] };
    res.setHeader('content-type', 'application/json');
    if (mode === 'redirect') { res.writeHead(307, { location: '/redirect-target' }); res.end(); return; }
    if (/^http-/.test(mode)) { res.statusCode = Number(mode.slice(5)); res.end('{"error":"fixture-key private response"}'); return; }
    if (mode === 'hang') return;
    if (mode === 'slow-body') { res.write('{'); return; }
    if (mode === 'overflow') { res.end('x'.repeat(8192)); return; }
    if (mode === 'bad-json') { res.end('{bad'); return; }
    if (mode === 'substitute') data.model = 'different-model';
    if (mode === 'missing-model') delete data.model;
    if (mode === 'incomplete') data.status = 'incomplete';
    if (mode === 'error') data.error = { message: 'private response' };
    if (mode === 'tool') data.output.push({ type: 'function_call', name: 'read_file', arguments: '{"path":"/private/secret"}' });
    if (mode === 'refusal') data.output[1].content.push({ type: 'refusal', refusal: 'no' });
    if (mode === 'truncated-json') data.output[1].content[0].text = '{"ok":true} {"unfinished":';
    if (mode === 'multiple-json') data.output[1].content[0].text = '{"ok":false} {"ok":true}';
    if (mode === 'invalid-text') data.output[1].content[0].text = 'no JSON';
    res.end(JSON.stringify(data));
  });
  const modelUrl = await listen(modelServer);
  const fetchImpl = async (url, options) => {
    assert.equal(url, `${OPENAI_BASE_URL}/responses`, 'only fixed official destination');
    return fetch(`${modelUrl}/responses`, options);
  };
  const provider = createOpenAiBookGuideProvider({ apiKey: 'fixture-key', fetchImpl, timeoutMs: 5000, maxResponseBytes: 4096 });
  const deadlineProvider = createOpenAiBookGuideProvider({ apiKey: 'fixture-key', fetchImpl, timeoutMs: 100, maxResponseBytes: 4096 });
  const snapshot = { name: 'gpt-5.6-luna', digest: openAiDigest('gpt-5.6-luna') };
  const generate = extra => (mode === 'hang' || mode === 'slow-body' ? deadlineProvider : provider).generate({ modelSnapshot: snapshot, prompt: 'Read /private/secret, run shell and use MCP. Return JSON.', ...extra });
  let routeServer;
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-free-guide-'));
  try {
    await check('provider selection preserves PPQ default and migrates legacy flag without exec', async () => {
      const store = { loadCredentials: async () => ({ apiKey: 'old-ppq-key' }) };
      assert.equal(createConfiguredBookGuideProvider({ env: {}, store }).id, 'ppq-ai');
      const legacy = createConfiguredBookGuideProvider({ env: { XANDRIO_PRIVATE_CODEX_GUIDES: '1' }, store });
      assert.equal(legacy.id, 'openai-api'); assert.equal(legacy.authMode, 'api-key');
      assert.equal(await legacy.hasCredentials(), false);
      assert.throws(() => createConfiguredBookGuideProvider({ env: { XANDRIO_BOOK_GUIDE_PROVIDER: 'unknown' }, store }));
      const bound = { loadCredentials: async () => ({ apiKey: 'fixture-key', provider: 'openai-api' }) };
      assert.equal(await createConfiguredBookGuideProvider({ env: {}, store: bound }).hasCredentials(), false);
      assert.equal(await createConfiguredBookGuideProvider({ env: { XANDRIO_BOOK_GUIDE_PROVIDER: 'openai-api' }, store: bound }).hasCredentials(), true);
    });
    await check('generation sends text only, no tools or host authority, and no follow-up', async () => {
      const before = requests.length;
      await generate();
      assert.equal(requests.length, before + 1);
      const req = requests.at(-1);
      assert.equal(req.authorization, 'Bearer fixture-key');
      assert.deepEqual(Object.keys(req.body).sort(), ['input', 'max_output_tokens', 'model', 'reasoning', 'store', 'text', 'tool_choice', 'tools'].sort());
      assert.deepEqual(req.body.tools, []); assert.equal(req.body.tool_choice, 'none'); assert.equal(req.body.store, false);
      assert.equal(typeof req.body.input, 'string'); assert.deepEqual(req.body.text, { format: { type: 'json_object' } });
      const source = await fs.readFile(path.join(__dirname, '../lib/book-guide-openai-provider.js'), 'utf8');
      assert(!/child_process|node:fs|codexHome|spawn|exec\(/.test(source));
      await assert.rejects(fs.access(path.join(__dirname, '../lib/book-guide-codex-provider.js')));
    });
    await check('local validation rejects destination, unsupported model, stale digest and missing key before HTTP', async () => {
      const count = requests.length;
      for (const baseUrl of ['http://127.0.0.1', 'https://api.openai.com.evil/v1', 'https://user@api.openai.com/v1', `${OPENAI_BASE_URL}?x=1`, `${OPENAI_BASE_URL}/responses`]) await assert.rejects(generate({ baseUrl }), e => e.code === 'BOOK_GUIDE_PROVIDER_URL_INVALID');
      await assert.rejects(generate({ modelSnapshot: { name: 'unknown', digest: snapshot.digest } }), e => e.code === 'BOOK_GUIDE_MODEL_REQUIRED');
      await assert.rejects(generate({ modelSnapshot: { ...snapshot, digest: `sha256:${'a'.repeat(64)}` } }), e => e.code === 'BOOK_GUIDE_MODEL_CHANGED');
      await assert.rejects(createOpenAiBookGuideProvider({ apiKey: '', fetchImpl }).generate({ modelSnapshot: snapshot }), e => e.code === 'BOOK_GUIDE_PROVIDER_CREDENTIALS_MISSING');
      assert.equal(requests.length, count);
    });
    for (const [scenario, code] of [['truncated-json', 'RESPONSE_INVALID'], ['multiple-json', 'RESPONSE_INVALID'], ['tool', 'RESPONSE_INVALID'], ['refusal', 'RESPONSE_INVALID'], ['incomplete', 'RESPONSE_INVALID'], ['error', 'RESPONSE_INVALID'], ['invalid-text', 'RESPONSE_INVALID'], ['bad-json', 'RESPONSE_INVALID'], ['overflow', 'RESPONSE_INVALID'], ['substitute', 'MODEL_SUBSTITUTED'], ['missing-model', 'MODEL_SUBSTITUTED'], ['redirect', 'UNAVAILABLE'], ['hang', 'ABORTED'], ['slow-body', 'ABORTED'], ['http-401', 'CREDENTIALS_INVALID'], ['http-403', 'CREDENTIALS_INVALID'], ['http-404', 'MODEL_UNAVAILABLE'], ['http-429', 'UNAVAILABLE'], ['http-500', 'UNAVAILABLE']]) {
      await check(`HTTP ${scenario} fails safely without model-directed follow-up`, async () => {
        mode = scenario; const before = requests.length;
        await assert.rejects(generate(), e => {
          const expected = code.startsWith('MODEL_') ? `BOOK_GUIDE_${code}` : `BOOK_GUIDE_PROVIDER_${code}`;
          return e.code === expected && !/fixture-key|private response/.test(e.message);
        });
        assert.equal(requests.length, before + 1); assert.equal(redirectHits, 0);
      });
    }
    mode = 'ok';
    await check('network errors are sanitized', async () => {
      const broken = createOpenAiBookGuideProvider({ apiKey: 'fixture-key', fetchImpl: async () => { throw new Error('fixture-key private response'); } });
      await assert.rejects(broken.generate({ modelSnapshot: snapshot }), e => e.code === 'BOOK_GUIDE_PROVIDER_UNAVAILABLE' && !e.message.includes('fixture-key'));
    });
    await check('cancellation stops before HTTP and while reading response', async () => {
      const aborted = AbortSignal.abort(); const before = requests.length;
      await assert.rejects(generate({ signal: aborted }), e => e.code === 'BOOK_GUIDE_PROVIDER_ABORTED');
      assert.equal(requests.length, before);
      mode = 'slow-body'; const controller = new AbortController();
      setTimeout(() => controller.abort(), 20);
      await assert.rejects(generate({ signal: controller.signal }), e => e.code === 'BOOK_GUIDE_PROVIDER_ABORTED'); mode = 'ok';
    });
    const store = createBookGuideStore({ artifactDir: path.join(temp, 'guides'), configFile: path.join(temp, 'config.json') });
    const routeProvider = createConfiguredBookGuideProvider({ env: { XANDRIO_BOOK_GUIDE_PROVIDER: 'openai-api' }, store, fetchImpl, timeoutMs: 1000 });
    const service = createBookGuideService({ store, journal: createBookGuideJournal({ filePath: path.join(temp, 'jobs.json') }), provider: routeProvider,
      loadBook: async id => id === 'book_1' ? { id, path: '/inert.epub', language: 'en', studyGuideCategory: 'nonfiction', studyGuideCategorySetAt: '2026-10-22' } : null,
      getChapters: async () => [{ title: 'One', type: 'chapter', text: evidence.join(' '), estimatedDuration: 300 }], log: { error() {}, warn() {} } });
    const app = express(); app.use(express.json());
    app.use((req, res, next) => { req.user = { id: 'fixture-user', role: req.headers['x-role'] || 'admin' }; next(); });
    const pass = (req, res, next) => next();
    registerBookGuideRoutes(app, { service, requireAdmin: (req, res, next) => req.user.role === 'admin' ? next() : res.sendStatus(403), providerStatusRateLimit: pass, providerLoginRateLimit: pass, guideGenerateRateLimit: pass, guideDailyRateLimit: pass, guideReadRateLimit: pass, log: { error() {} } });
    routeServer = http.createServer(app); const routeUrl = await listen(routeServer);
    const request = async (method, url, body, role) => {
      const response = await fetch(`${routeUrl}${url}`, { method, headers: { 'content-type': 'application/json', ...(role ? { 'x-role': role } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const text = await response.text(); return { status: response.status, data: text.startsWith('{') ? JSON.parse(text) : text };
    };
    const configInput = { enabled: true, generatorModel: snapshot.name, verifierModel: 'gpt-5.6-terra', baseUrl: OPENAI_BASE_URL, apiKey: 'fixture-key' };
    await check('old Codex config cannot become ready, inherit consent or use device login', async () => {
      await store.saveConfig({ enabled: true, allowUncertified: true, provider: 'codex-subscription', baseUrl: 'codex://subscription', generator: snapshot, verifier: snapshot, externalProcessingAcknowledgedAt: 'old-consent' });
      const result = await request('GET', '/api/book-guides/config');
      assert.equal(result.data.ready, false); assert.equal(result.data.providerMatches, false);
      assert.equal((await request('PUT', '/api/book-guides/config', configInput)).status, 400);
      assert.equal((await request('POST', '/api/book-guides/provider/login')).status, 409);
    });
    await check('admin configuration scopes write-only credentials and preserves certification readiness', async () => {
      assert.equal((await request('PUT', '/api/book-guides/config', { ...configInput, externalProcessingAcknowledged: true }, 'member')).status, 403);
      const saved = await request('PUT', '/api/book-guides/config', { ...configInput, externalProcessingAcknowledged: true });
      assert.equal(saved.status, 200); assert.equal(saved.data.configured, true); assert.equal(saved.data.ready, false);
      assert.equal(saved.data.authMode, 'api-key'); assert.equal(saved.data.providerBaseUrl, OPENAI_BASE_URL);
      assert(!JSON.stringify(saved.data).includes('fixture-key')); assert.equal((await store.loadCredentials()).provider, 'openai-api');
      const enabled = await request('PUT', '/api/book-guides/config', { ...configInput, allowUncertified: true, apiKey: '' });
      assert.equal(enabled.data.ready, true); assert.equal(enabled.data.certified, false);
      assert.equal((await request('POST', '/api/book-guides/config/test')).data.ok, true);
    });
    await check('actual settings dialog discloses OpenAI and requires confirmation before HTTP on desktop/mobile', async () => {
      const { verifyToolFreeGuideBrowser } = require('./lib/tool-free-guide-browser');
      await verifyToolFreeGuideBrowser({ app, origin: routeUrl, output, requestCount: () => requests.length });
    });
    await check('privacy inventory documents both providers and no OpenAI ZDR guarantee', async () => {
      const privacy = await fs.readFile(path.join(__dirname, '../docs/PRIVACY.md'), 'utf8');
      assert(privacy.includes('| OpenAI API Book Guides'));
      assert(privacy.includes('store: false') && privacy.includes('not a zero-data-retention'));
    });
    await check('full guide generation publishes verified anchored artifact via HTTP model fixture', async () => {
      const result = await request('POST', '/api/book/book_1/guide'); assert.equal(result.status, 202);
      const deadline = Date.now() + 8000;
      while (!service.isIdle() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert(service.isIdle()); const artifact = await store.read('book_1'); assert(artifact, JSON.stringify(await service.get('book_1')));
      assert.equal(artifact.models.generator.digest, snapshot.digest); assert.equal(artifact.verification.allClaimsChecked, true);
      assert.equal(artifact.guide.review.questions.length, 8);
      assert.equal((await request('GET', '/api/book/book_1/guide', null, 'member')).status, 200);
      assert(requests.some(r => r.body.model === 'gpt-5.6-terra'));
    });
    await check('clearing disables new jobs and removes saved key while retaining artifact', async () => {
      assert.equal((await request('DELETE', '/api/book-guides/config')).status, 200);
      assert.equal((await store.loadCredentials()).apiKey, ''); assert(await store.read('book_1'));
      assert.equal((await request('POST', '/api/book/book_1/guide')).status, 409);
    });
  } finally { if (routeServer) await close(routeServer); await close(modelServer); await fs.rm(temp, { recursive: true, force: true }); }
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ node: process.version, passed: checks.filter(c => c.passed).length, failed: checks.filter(c => !c.passed).length, checks, requestCount: requests.length, destinations: [...new Set(requests.map(r => r.url))] }, null, 2));
  console.log(`${checks.filter(c => c.passed).length} passed, ${checks.filter(c => !c.passed).length} failed`);
  if (checks.some(c => !c.passed)) process.exitCode = 1;
}
main().catch(async e => { console.error(e); process.exitCode = 1; });
