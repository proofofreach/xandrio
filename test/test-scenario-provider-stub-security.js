'use strict';

const assert = require('node:assert/strict');
const {
  createTtsEngineStub,
  createProviderNetworkStub
} = require('./fixtures/scenarios/lib/provider-stub');

async function responseBody(url, options) {
  const response = await fetch(url, options);
  assert.equal(response.status, 500);
  return response.json();
}

async function main() {
  const expected = { error: 'Scenario provider failed' };

  const tts = createTtsEngineStub('fixture');
  const ttsPort = await tts.listen(0);
  try {
    const body = await responseBody(`http://127.0.0.1:${ttsPort}/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{private-fixture-detail'
    });
    assert.deepEqual(body, expected);
    console.log('  ✓ TTS stub does not expose parser diagnostics');
  } finally {
    await tts.close();
  }

  const provider = createProviderNetworkStub({});
  const providerPort = await provider.listen(0);
  try {
    const body = await responseBody(`http://127.0.0.1:${providerPort}/feeds/opds`, {
      headers: { 'x-scenario-target-host': 'standardebooks.org' }
    });
    assert.deepEqual(body, expected);
    console.log('  ✓ network stub does not expose internal exception details');
  } finally {
    await provider.close();
  }

  console.log('2 passed, 0 failed');
}

main().catch(error => {
  console.error(error);
  console.log('0 passed, 1 failed');
  process.exitCode = 1;
});
