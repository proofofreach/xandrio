const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { getMasteringBitrate } = require('./audio-quality');

// Shared across the whole recovery tree, in addition to the initial three takes.
const RECOVERY_LIMITS = { minimumCharacters: 24, maximumDepth: 3, maximumAttempts: 12, deadlineMs: 180000 };
const PROCESS_STARTED_AT = Date.now() - process.uptime() * 1000;
const characterCount = text => Array.from(text.replace(/\s/gu, '')).length;

// A normal failure removes its own directory. After process death, only sweep
// directories whose recorded owner PID no longer exists. Never touch live-owner,
// unrecognized, or symlink entries in a shared cache.
async function removeAbandonedNanoRecovery(cacheDir) {
  const root = await fs.realpath(cacheDir).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (!root) return 0;
  let removed = 0;
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const owner = entry.name.match(/^\.nano-recovery-([1-9]\d*)-[A-Za-z0-9]+$/);
    if (!owner) continue;
    const pid = Number(owner[1]);
    if (!Number.isSafeInteger(pid) || pid > 2147483647) continue;
    // Containers commonly reuse PID 1. A directory last changed before this
    // process started cannot belong to one of its active renders.
    const oldOwnPid = pid === process.pid && await fs.stat(path.join(root, entry.name))
      .then(stat => stat.mtimeMs < PROCESS_STARTED_AT, error => {
        if (error.code !== 'ENOENT') throw error;
        return false;
      });
    if (!oldOwnPid) {
      try {
        process.kill(pid, 0);
        continue;
      } catch (error) {
        if (error.code !== 'ESRCH') continue;
      }
    }
    await fs.rm(path.join(root, entry.name), { recursive: true, force: true });
    removed++;
  }
  return removed;
}

function exhausted(reason) {
  return Object.assign(new Error(`MOSS Nano recovery exhausted: ${reason}`), { code: 'NANO_RECOVERY_EXHAUSTED' });
}

function isRecoverableNanoFailure(error) {
  return error?.code === 'NANO_AUDIO_SHORT' || error?.code === 'NANO_AUDIO_STATIC'
    || error?.httpStatus === 422 && error?.synthesisFailureCode === 'NANO_FRAME_LIMIT';
}

// Retain exact offsets, including whitespace and closing quotes. The caller has
// already prepared/adapted this text; fragments must never be prepared again.
function splitRecoveryText(text) {
  const minimum = RECOVERY_LIMITS.minimumCharacters;
  const parts = [];
  let start = 0;
  const boundary = /(?:[.!?]+[”’"'»」』）)]*(?:\s+|$)|[。！？]+[”’"'»」』）)]*\s*)/gu;
  for (const match of text.matchAll(boundary)) {
    const end = match.index + match[0].length;
    if (characterCount(text.slice(start, end)) >= minimum) {
      parts.push(text.slice(start, end)); start = end;
    }
  }
  if (start < text.length) {
    const tail = text.slice(start);
    if (parts.length && characterCount(tail) < minimum) parts[parts.length - 1] += tail;
    else parts.push(tail);
  }
  if (parts.length > 1 && parts.every(part => characterCount(part) >= minimum)) return parts;
  // Without a safe sentence boundary, divide at the nearest usable whitespace.
  // Unpunctuated continuous scripts/words fail explicitly rather than lose text.
  const cuts = [...text.matchAll(/\s+/gu)].map(match => match.index + match[0].length)
    .filter(cut => characterCount(text.slice(0, cut)) >= minimum && characterCount(text.slice(cut)) >= minimum)
    .sort((a, b) => Math.abs(a - text.length / 2) - Math.abs(b - text.length / 2));
  return cuts.length ? [text.slice(0, cuts[0]), text.slice(cuts[0])] : [];
}

async function concatenateFragments(files, outputPath, padEndMs, signal) {
  const manifest = path.join(path.dirname(outputPath), 'concat.txt');
  // All entries are generated numeric filenames in this private directory.
  await fs.writeFile(manifest, files.map(file => `file '${path.basename(file)}'`).join('\n'));
  signal.throwIfAborted();
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '1', '-i', manifest];
  if (padEndMs > 0) args.push('-af', `apad=pad_dur=${(padEndMs / 1000).toFixed(3)}`);
  args.push('-ac', '1', '-ar', '24000');
  args.push(...(outputPath.endsWith('.wav') ? ['-c:a', 'pcm_s16le'] : ['-c:a', 'libmp3lame', '-b:a', getMasteringBitrate()]));
  args.push(outputPath);
  await new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { signal, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 }, error => error ? reject(error) : resolve());
  });
  signal.throwIfAborted();
}

async function recoverNanoSynthesis({ text, directory, outputPath, padEndMs, signal, generate, validate }) {
  const deadline = new AbortController();
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const timer = setTimeout(() => deadline.abort(), RECOVERY_LIMITS.deadlineMs);
  let attempts = 0, sequence = 0;
  const leaves = [];
  const beforeAttempt = () => {
    combined.throwIfAborted();
    if (attempts >= RECOVERY_LIMITS.maximumAttempts) throw exhausted('shared attempt limit');
    attempts++;
  };
  async function splitAndRender(fragment, depth) {
    if (depth >= RECOVERY_LIMITS.maximumDepth) throw exhausted('split depth limit');
    const parts = splitRecoveryText(fragment);
    if (parts.length < 2) throw exhausted('no smaller safe text boundary');
    if (parts.join('') !== fragment || parts.some(part => part.length >= fragment.length)) {
      throw new Error('Nano recovery source coverage mismatch');
    }
    for (const part of parts) {
      combined.throwIfAborted();
      const file = path.join(directory, `${++sequence}.wav`);
      try {
        await generate(part, file, combined, beforeAttempt);
        combined.throwIfAborted();
        leaves.push({ text: part, file });
      } catch (error) {
        combined.throwIfAborted();
        if (!isRecoverableNanoFailure(error)) throw error;
        await splitAndRender(part, depth + 1);
      }
    }
  }
  try {
    await splitAndRender(text, 0);
    if (leaves.map(leaf => leaf.text).join('') !== text) throw new Error('Nano recovery source coverage mismatch');
    await concatenateFragments(leaves.map(leaf => leaf.file), outputPath, padEndMs, combined);
    await validate(outputPath, combined);
    combined.throwIfAborted();
    return { attempts, fragments: leaves.length };
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (deadline.signal.aborted) throw Object.assign(new Error('MOSS Nano recovery deadline exceeded'), { code: 'NANO_RECOVERY_DEADLINE' });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { RECOVERY_LIMITS, isRecoverableNanoFailure, recoverNanoSynthesis, removeAbandonedNanoRecovery };
