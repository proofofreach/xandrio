const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { connectEdgeWebSocket, synthesizeEdgeTts } = require('../lib/abortable-edge-tts');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) { passed++; console.log(`  PASS ${message}`); }
  else { failed++; console.error(`  FAIL ${message}`); }
}

class BlackholedSocket extends EventEmitter {
  static latest = null;
  constructor() {
    super();
    this.terminated = false;
    BlackholedSocket.latest = this;
  }
  terminate() { this.terminated = true; }
  send() {}
}

class CompletingSocket extends EventEmitter {
  static latest = null;
  constructor() {
    super();
    this.sent = [];
    this.closed = false;
    CompletingSocket.latest = this;
    setImmediate(() => this.emit('open'));
  }
  send(payload) {
    this.sent.push(String(payload));
    if (!String(payload).includes('Path:ssml')) return;
    setImmediate(() => {
      this.emit('message', Buffer.concat([Buffer.from('Path:audio\r\n'), Buffer.from('audio-bytes')]), true);
      this.emit('message', Buffer.from('Path:turn.end'), false);
    });
  }
  close() { this.closed = true; }
  terminate() { this.terminated = true; }
}

(async () => {
  const controller = new AbortController();
  const startedAt = Date.now();
  const connection = connectEdgeWebSocket({
    outputFormat: 'audio-24khz-48kbitrate-mono-mp3', timeout: 5000
  }, controller.signal, BlackholedSocket);
  controller.abort();
  let error = null;
  try { await connection; } catch (caught) { error = caught; }
  assert(error?.name === 'AbortError', 'cancelled Edge handshake rejects with AbortError');
  assert(Date.now() - startedAt < 250, 'cancelled Edge handshake settles promptly');
  assert(BlackholedSocket.latest?.terminated === true, 'cancelled Edge handshake terminates its socket immediately');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xandrio-edge-'));
  const audioPath = path.join(tempDir, 'sample.mp3');
  await synthesizeEdgeTts({
    outputFormat: 'audio-24khz-48kbitrate-mono-mp3', timeout: 1000,
    lang: 'en-US', voice: 'en-US-Test', rate: '+0%', pitch: '+0Hz', volume: '+0%'
  }, 'A <safe> test', audioPath, undefined, CompletingSocket);
  assert(fs.readFileSync(audioPath).toString() === 'audio-bytes', 'full synthesis writes binary audio payload');
  assert(CompletingSocket.latest.sent.some(payload => payload.includes('Path:speech.config')), 'full synthesis sends speech configuration');
  assert(CompletingSocket.latest.sent.some(payload => payload.includes('A &lt;safe&gt; test')), 'full synthesis sends escaped SSML');
  assert(CompletingSocket.latest.closed === true, 'full synthesis closes its socket after turn end');
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
