/**
 * Playback start gate shared by the runway status poll and the media routes.
 *
 * The default rule is two contiguous ready chunks from the playback target.
 * A single ready chunk is enough only when measured engine speed shows the
 * next chunk will be ready well before the first one finishes playing at the
 * listener's speed (the fastest speed when unknown). Engines slower than real time, queued next chunks,
 * reused audio without timing, and missing durations all fall back to the
 * two-chunk rule.
 */

const PLAYBACK_STARTUP_CHUNKS = 2;
// Fastest selectable player speed (public/js/views/playback-speed.js). The
// runway poll reports the listener's speed; requests that do not (media
// routes, older clients) assume the fastest. Media requests normally follow a
// granted poll and reuse its sticky grant (lib/playback-orchestrator.js).
const MAX_PLAYBACK_RATE = 3;
// The predicted remaining synthesis time must fit twice into the budget.
const EARLY_START_SAFETY_FACTOR = 2;
// Media startup, first-segment encode, and transport before the playhead moves.
const EARLY_START_ALLOWANCE_SECONDS = 2;

/**
 * @param {object} input
 * @param {{status: string, textLength?: number}} input.ready - the ready target chunk
 * @param {{status: string, textLength?: number}} input.next - the following chunk
 * @param {{synthesisMs: number|null}|null} input.readyTiming - target chunk timing
 * @param {{startedAt: number, synthesisMs: number|null}|null} input.nextTiming
 * @param {number|null} input.readyDurationSeconds - playable seconds of the target
 * @param {number} input.now - epoch milliseconds
 * @param {number} [input.playbackRate] - listener speed; unknown means the fastest
 * @returns {boolean}
 */
function nextChunkArrivesInTime({
  ready,
  next,
  readyTiming,
  nextTiming,
  readyDurationSeconds,
  now,
  playbackRate = null
}) {
  // The manifest can still say 'queued' for a job that already started; the
  // queue's live synthesis start (nextTiming) is the authority on progress.
  if (ready?.status !== 'ready' || !['queued', 'generating'].includes(next?.status)) return false;
  const synthesisMs = Number(readyTiming?.synthesisMs);
  const startedAt = Number(nextTiming?.startedAt);
  const duration = Number(readyDurationSeconds);
  const readyChars = Number(ready.textLength);
  const nextChars = Number(next.textLength);
  if (!(synthesisMs > 0) || !Number.isFinite(startedAt) || !(duration > 0) ||
      !(readyChars > 0) || !(nextChars > 0)) {
    return false;
  }
  // Scale by length, but never predict a longer chunk to be faster: fixed
  // request latency makes this overestimate, which is the safe direction.
  const predictedMs = synthesisMs * Math.max(1, nextChars / readyChars);
  const remainingMs = startedAt + predictedMs - now;
  // Past its prediction, the next chunk is slower than measured. Stop
  // trusting the estimate and wait for it.
  if (remainingMs < 0) return false;
  // Slower than 1x earns no extra budget; unknown or invalid means fastest.
  const rate = Number(playbackRate) > 0
    ? Math.min(MAX_PLAYBACK_RATE, Math.max(1, Number(playbackRate)))
    : MAX_PLAYBACK_RATE;
  const budgetSeconds = duration / rate;
  return remainingMs / 1000 * EARLY_START_SAFETY_FACTOR + EARLY_START_ALLOWANCE_SECONDS <= budgetSeconds;
}

// Narration the current chapter keeps generated ahead of its playback
// position before the next chapter's look-ahead may compete for the engine:
// about 6.7 minutes of speech at 15 characters per second. Without it, a
// one-chunk start and a short ramp leave the current chapter's next chunks
// at background priority, behind the following chapter's look-ahead.
const PLAYBACK_BUFFER_CHARS = 6000;

/**
 * Chunks after `fromIndex` that still fall inside the playback buffer: the
 * narration from `fromIndex` up to (not including) the chunk is shorter than
 * PLAYBACK_BUFFER_CHARS. The chunk right after `fromIndex` always qualifies.
 */
function playbackBufferIndexes(chunks, fromIndex) {
  const indexes = [];
  if (!Array.isArray(chunks)) return indexes;
  let charsBefore = 0;
  for (let index = fromIndex + 1; index < chunks.length; index++) {
    charsBefore += Math.max(0, Number(chunks[index - 1]?.textLength) || 0);
    if (index > fromIndex + 1 && charsBefore >= PLAYBACK_BUFFER_CHARS) break;
    indexes.push(index);
  }
  return indexes;
}

/**
 * Generation priority for a chapter being played from `targetChunk`: the
 * target is immediate; the playback buffer after it is `next`, which outranks
 * every chapter's look-ahead; the rest of the chapter is background.
 * Signature matches ChunkedTTS priorityForChunk(chunkIndex, isFirstPending, chunks).
 */
function playbackChunkPriority(targetChunk = 0) {
  return (chunkIndex, isFirstPending, chunks = null) => {
    if (chunkIndex === targetChunk) return 'immediate';
    if (chunkIndex === targetChunk + 1) return 'next';
    if (isFirstPending && targetChunk === 0) return 'immediate';
    if (chunkIndex > targetChunk && playbackBufferIndexes(chunks, targetChunk).includes(chunkIndex)) return 'next';
    return 'background';
  };
}

module.exports = {
  PLAYBACK_STARTUP_CHUNKS,
  MAX_PLAYBACK_RATE,
  EARLY_START_SAFETY_FACTOR,
  EARLY_START_ALLOWANCE_SECONDS,
  PLAYBACK_BUFFER_CHARS,
  nextChunkArrivesInTime,
  playbackBufferIndexes,
  playbackChunkPriority
};
