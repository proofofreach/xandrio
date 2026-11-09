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

const { isSpeakableText, packNarrationPieces, splitOversizedText } = require('./tts-text');
const {
  HYBRID_SPLIT_POLICY,
  PARAGRAPH_SPLIT_POLICY,
  RAMP_FIRST_MAX_CHARS,
  RAMP_SPLIT_POLICY,
  normalizeSplitPolicy,
  planNarrationForPolicy
} = require('./tts-split-policy');

const HYBRID_MAX_CHARS = 900;

// Tokens without a letter or digit (ornaments, symbol runs) carry nothing to
// speak. Removing them salvages prose that arrived glued to such a run.
function withoutSymbolTokens(text) {
  return String(text || '')
    .split(/(\s+)/)
    .filter(token => !token.trim() || /[\p{L}\p{N}]/u.test(token))
    .join('')
    .replace(/[^\S\n]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function withoutSymbolChunks(chunks) {
  return chunks.map(chunk => ({
    ...chunk,
    text: withoutSymbolTokens(chunk.text),
    segments: (chunk.segments || [])
      .map(segment => ({ ...segment, text: withoutSymbolTokens(segment.text) }))
      .filter(segment => segment.text)
  })).filter(chunk => chunk.text);
}

function prependChunks(prefixes, chunk) {
  return {
    ...chunk,
    text: `${prefixes.map(prefix => prefix.text).join('\n\n')}\n\n${chunk.text}`,
    segments: prefixes.flatMap(prefix => prefix.segments || []).concat(chunk.segments || [])
  };
}

function appendChunks(last, suffixes) {
  return {
    ...last,
    text: `${last.text}\n\n${suffixes.map(suffix => suffix.text).join('\n\n')}`,
    paragraphFinal: true,
    pauseIntent: suffixes[suffixes.length - 1]?.pauseIntent || 'paragraph',
    segments: (last.segments || []).concat(suffixes.flatMap(suffix => suffix.segments || []))
  };
}

/**
 * Attach chunks too short or too symbol-heavy to synthesize alone to a
 * neighbour. A merge must leave a speakable chunk within maxChars, so a run
 * that cannot join the next chunk whole takes only its leading segments, or
 * joins the previous chunk. Failing both, the run is retried without its
 * symbol runs. Only text with nothing speakable is left out: a speakable
 * chunk is never dropped or enlarged past maxChars.
 */
function coalesceUnspeakableChunks(chunks, splitPolicy, maxChars = Infinity) {
  if (splitPolicy === PARAGRAPH_SPLIT_POLICY) {
    // Short dialogue is still authored speech. Merging it into the next
    // paragraph would undo this policy and can also exceed the chunk bound.
    const speakable = chunk => isSpeakableText(chunk.text, { minimumLength: 1 });
    return chunks.flatMap(chunk => speakable(chunk) ? [chunk] : withoutSymbolChunks([chunk]).filter(speakable));
  }
  const fits = chunk => chunk.text.length <= maxChars && isSpeakableText(chunk.text);
  const output = [];
  const queue = chunks.slice();
  let pending = [];

  // Settle the pending run before `next`, or after the last chunk when null.
  const settle = next => {
    const run = pending;
    pending = [];
    if (next) {
      const forward = prependChunks(run, next);
      if (fits(forward)) return output.push(forward);
      const parts = splitChunkToMax(forward, maxChars);
      if (parts.length > 1 && fits(parts[0]) && parts[0].segments.length > countSegments(run)) {
        output.push(parts[0]);
        return queue.unshift(...parts.slice(1));
      }
    }
    const last = output[output.length - 1];
    const backward = last && appendChunks(last, run);
    if (backward && fits(backward)) {
      output[output.length - 1] = backward;
    } else {
      const salvaged = withoutSymbolChunks(run);
      if (salvaged.length !== run.length || salvaged.some((chunk, index) => chunk.text !== run[index].text)) {
        return queue.unshift(...salvaged, ...(next ? [next] : []));
      }
      // A short run such as "5." beside full chunks: open the next chunk with
      // the run and the start of its text, or close the previous chunk with
      // the end of its text and the run.
      const lead = next ? leadWithRun(run, next, maxChars) : [];
      if (lead.length > 1 && lead.every(fits)) {
        output.push(lead[0]);
        return queue.unshift(...lead.slice(1));
      }
      const trail = last ? trailWithRun(last, run, maxChars, fits) : [];
      if (trail.length > 1) {
        output.splice(output.length - 1, 1, ...trail);
      }
    }
    if (next) output.push(next);
  };

  while (queue.length) {
    const chunk = queue.shift();
    if (!isSpeakableText(chunk.text)) pending.push(chunk);
    else if (pending.length) settle(chunk);
    else output.push(chunk);
    if (!queue.length && pending.length) settle(null);
  }
  return output;
}

// Leave the remainder of a divided segment long enough to stand alone.
const MIN_SPLIT_TAIL_CHARS = 40;

function leadWithRun(run, next, maxChars) {
  const [first, ...rest] = next.segments || [];
  const room = Math.min(
    maxChars - run.reduce((sum, chunk) => sum + chunk.text.length + 2, 0),
    (first?.text.length || 0) - MIN_SPLIT_TAIL_CHARS
  );
  if (!first || room < 20) return [];
  const runSegments = run.flatMap(chunk => chunk.segments || []);
  const [lead, ...tail] = splitSegment(first, room);
  const head = toChunk(packNarrationPieces([...runSegments, lead], maxChars));
  return head ? [head, ...packNarrationPieces([...tail, ...rest], maxChars).map(part => toChunk([part]))] : [];
}

function trailWithRun(last, run, maxChars, fits) {
  const segments = last.segments || [];
  const runSegments = run.flatMap(chunk => chunk.segments || []);
  const attempt = (front, back) => {
    const parts = [toChunk(packNarrationPieces(front, maxChars)), toChunk(packNarrationPieces([...back, ...runSegments], maxChars))];
    return parts.every(part => part && fits(part)) ? parts : null;
  };
  for (let count = 1; count < segments.length; count++) {
    const parts = attempt(segments.slice(0, -count), segments.slice(-count));
    if (parts) return parts;
  }
  const final = segments[segments.length - 1];
  const room = (final?.text.length || 0) - MIN_SPLIT_TAIL_CHARS;
  if (room < 20) return [];
  const [head, ...tail] = splitSegment(final, room);
  return attempt([...segments.slice(0, -1), head], tail) || [];
}

function countSegments(chunks) {
  return chunks.reduce((sum, chunk) => sum + (chunk.segments?.length || 0), 0);
}

function splitSegment(segment, maxChars) {
  if (segment.text.length <= maxChars) return [segment];
  const parts = splitOversizedText(segment.text, maxChars, { documentStart: false });
  return parts.map((text, index) => {
    const last = index === parts.length - 1;
    return {
      ...segment,
      text,
      paragraphFinal: last && segment.paragraphFinal,
      pauseIntent: last || segment.kind === 'heading' ? segment.pauseIntent : 'sentence'
    };
  });
}

// One packed part as planner output; null when the pieces did not fit one part.
function toChunk(parts) {
  if (parts.length !== 1) return null;
  const [part] = parts;
  return {
    text: part.text,
    paragraphFinal: part.paragraphFinal,
    pauseIntent: part.segments[part.segments.length - 1]?.pauseIntent || 'sentence',
    segments: part.segments
  };
}

/**
 * Packing can overfill a chunk behind an unspeakable lead-in. Re-pack such a
 * chunk from its segments so no synthesis request exceeds the policy bound.
 */
function splitChunkToMax(chunk, maxChars) {
  if (chunk.text.length <= maxChars || !chunk.segments?.length) return [chunk];
  const pieces = chunk.segments.flatMap(segment => splitSegment(segment, maxChars));
  return packNarrationPieces(pieces, maxChars).map(part => toChunk([part]));
}

// The longest chunk each policy plans; hybrid continuations use a fixed bound.
function policyMaxChars(policy, maxChars) {
  return policy === HYBRID_SPLIT_POLICY
    ? Math.max(Math.min(420, maxChars), HYBRID_MAX_CHARS)
    : maxChars;
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
        maxChars: HYBRID_MAX_CHARS,
        minChars: 200
      });
  const limit = policyMaxChars(policy, maxChars);
  const chunks = plan.chunks.map(chunk => ({
    text: chunk.text,
    paragraphFinal: chunk.paragraphFinal,
    pauseIntent: chunk.segments[chunk.segments.length - 1]?.pauseIntent || 'sentence',
    segments: chunk.segments.map(segment => ({ ...segment }))
  })).flatMap(chunk => splitChunkToMax(chunk, limit));
  return coalesceUnspeakableChunks(chunks, policy, limit);
}

module.exports = { planSplitChunks, coalesceUnspeakableChunks };
