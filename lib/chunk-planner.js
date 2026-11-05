/**
 * Pure chunk planner: (text, maxChars, splitPolicy) -> chunk metadata.
 *
 * This is the CPU-heavy core of ChunkedTTS text splitting (150-300 ms per
 * long chapter on the production CPU). It depends on nothing but its
 * arguments, so lib/chunk-plan-worker.js runs it on a worker thread and
 * lib/chunk-plan-pool.js falls back to calling it in-process. Every input
 * and output is plain data (strings, numbers, booleans), which keeps the
 * result identical across the structured-clone boundary.
 */

const { isSpeakableText } = require('./tts-text');
const {
  HYBRID_SPLIT_POLICY,
  PARAGRAPH_SPLIT_POLICY,
  RAMP_FIRST_MAX_CHARS,
  RAMP_SPLIT_POLICY,
  normalizeSplitPolicy,
  planNarrationForPolicy
} = require('./tts-split-policy');

function coalesceUnspeakableChunks(chunks, splitPolicy) {
  if (splitPolicy === PARAGRAPH_SPLIT_POLICY) {
    // Short dialogue is still authored speech. Merging it into the next
    // paragraph would undo this policy and can also exceed the chunk bound.
    return chunks.filter(chunk => isSpeakableText(chunk.text, { minimumLength: 1 }));
  }
  const output = [];
  let pendingPrefix = [];

  for (const chunk of chunks) {
    if (isSpeakableText(chunk.text)) {
      output.push({
        ...chunk,
        text: pendingPrefix.length
          ? `${pendingPrefix.map(prefix => prefix.text).join('\n\n')}\n\n${chunk.text}`
          : chunk.text,
        segments: pendingPrefix.length
          ? pendingPrefix.flatMap(prefix => prefix.segments || []).concat(chunk.segments || [])
          : chunk.segments
      });
      pendingPrefix = [];
    } else {
      pendingPrefix.push(chunk);
    }
  }

  if (pendingPrefix.length && output.length) {
    const last = output[output.length - 1];
    output[output.length - 1] = {
      ...last,
      text: `${last.text}\n\n${pendingPrefix.map(suffix => suffix.text).join('\n\n')}`,
      paragraphFinal: true,
      pauseIntent: pendingPrefix[pendingPrefix.length - 1]?.pauseIntent || 'paragraph',
      segments: (last.segments || []).concat(pendingPrefix.flatMap(suffix => suffix.segments || []))
    };
  }

  return output.filter(chunk => isSpeakableText(chunk.text));
}

/**
 * @param {string} text
 * @param {number} maxChars
 * @param {string} splitPolicy - a normalized split policy id
 * @returns {{text: string, paragraphFinal: boolean, pauseIntent: string, segments: object[]}[]}
 */
function planSplitChunks(text, maxChars, splitPolicy) {
  const policy = normalizeSplitPolicy(splitPolicy);
  const plan = policy === RAMP_SPLIT_POLICY
    ? planNarrationForPolicy(text, {
        policy,
        firstMaxChars: Math.min(RAMP_FIRST_MAX_CHARS, maxChars),
        maxChars
      })
    : planNarrationForPolicy(text, {
        policy,
        firstMaxChars: policy === HYBRID_SPLIT_POLICY
          ? Math.min(420, maxChars)
          : maxChars,
        targetChars: 750,
        maxChars: 900,
        minChars: 200
      });
  const chunks = plan.chunks.map(chunk => ({
    text: chunk.text,
    paragraphFinal: chunk.paragraphFinal,
    pauseIntent: chunk.segments[chunk.segments.length - 1]?.pauseIntent || 'sentence',
    segments: chunk.segments.map(segment => ({ ...segment }))
  }));
  return coalesceUnspeakableChunks(chunks, policy);
}

module.exports = { planSplitChunks, coalesceUnspeakableChunks };
