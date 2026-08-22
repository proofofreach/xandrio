'use strict';

// Deterministic mono 16-bit PCM WAV generator, mirroring the pattern already
// used by scripts/smoke-browser.js and scripts/verify-android-lockscreen.js.
// A pure sine tone (not silence, not noise) reliably clears tts-queue.js's
// truncation and static-noise checks, so the provider stub can stand in for
// Kokoro/Chatterbox without the real server ever reaching a real TTS engine.
function wavBuffer(durationSeconds, { sampleRate = 24000, frequency = 220 } = {}) {
  const samples = Math.max(1, Math.round(sampleRate * durationSeconds));
  const dataBytes = samples * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples; i++) {
    const value = Math.round(Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 6000);
    wav.writeInt16LE(value, 44 + i * 2);
  }
  return wav;
}

// Same minimum-duration formula tts-queue.js uses to validate chunk output
// (minExpectedChunkSeconds), plus headroom so rounding never trips it.
function ttsResponseWavForText(text) {
  const minSeconds = Math.max(0.4, String(text || '').length / 45);
  return wavBuffer(minSeconds + 0.5);
}

module.exports = { wavBuffer, ttsResponseWavForText };
