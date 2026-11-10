// Incremental SHA-256 (FIPS 180-4).
//
// Web Crypto only digests a complete buffer, so checking a stored chapter
// against its whole-file hash used to hold the entire chapter in memory, often
// several copies of it. On iOS that is enough to get the page killed. This
// hash takes the body one chunk at a time, so verification needs a few
// kilobytes whatever the chapter size.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

export function createSha256() {
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]);
  const words = new Uint32Array(64);
  const pending = new Uint8Array(64);
  let pendingLength = 0;
  let totalBytes = 0;
  let finished = false;

  function compress(bytes, offset) {
    for (let i = 0; i < 16; i++) {
      const j = offset + (i * 4);
      words[i] = (bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const w15 = words[i - 15];
      const w2 = words[i - 2];
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      words[i] = (words[i - 16] + s0 + words[i - 7] + s1) | 0;
    }
    let a = state[0];
    let b = state[1];
    let c = state[2];
    let d = state[3];
    let e = state[4];
    let f = state[5];
    let g = state[6];
    let h = state[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + words[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    state[0] += a;
    state[1] += b;
    state[2] += c;
    state[3] += d;
    state[4] += e;
    state[5] += f;
    state[6] += g;
    state[7] += h;
  }

  function update(chunk) {
    if (finished) throw new Error('SHA-256 already finalized');
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    totalBytes += bytes.byteLength;
    let offset = 0;
    if (pendingLength > 0) {
      const take = Math.min(64 - pendingLength, bytes.byteLength);
      pending.set(bytes.subarray(0, take), pendingLength);
      pendingLength += take;
      offset = take;
      if (pendingLength < 64) return;
      compress(pending, 0);
      pendingLength = 0;
    }
    while (offset + 64 <= bytes.byteLength) {
      compress(bytes, offset);
      offset += 64;
    }
    if (offset < bytes.byteLength) {
      pending.set(bytes.subarray(offset), 0);
      pendingLength = bytes.byteLength - offset;
    }
  }

  function digestHex() {
    if (finished) throw new Error('SHA-256 already finalized');
    finished = true;
    const bitsHigh = Math.floor(totalBytes / 0x20000000);
    const bitsLow = (totalBytes * 8) >>> 0;
    pending[pendingLength++] = 0x80;
    if (pendingLength > 56) {
      pending.fill(0, pendingLength);
      compress(pending, 0);
      pendingLength = 0;
    }
    pending.fill(0, pendingLength, 56);
    pending[56] = bitsHigh >>> 24;
    pending[57] = bitsHigh >>> 16;
    pending[58] = bitsHigh >>> 8;
    pending[59] = bitsHigh;
    pending[60] = bitsLow >>> 24;
    pending[61] = bitsLow >>> 16;
    pending[62] = bitsLow >>> 8;
    pending[63] = bitsLow;
    compress(pending, 0);
    let hex = '';
    for (const word of state) hex += word.toString(16).padStart(8, '0');
    return hex;
  }

  return { update, digestHex, bytes: () => totalBytes };
}
