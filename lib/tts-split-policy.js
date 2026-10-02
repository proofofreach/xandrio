const {
  buildNarrationPieces,
  planNarration
} = require('./tts-text');

const LEGACY_SPLIT_POLICY = 'legacy-v1';
const HYBRID_SPLIT_POLICY = 'hybrid-v1';
const PARAGRAPH_SPLIT_POLICY = 'paragraph-v1';
const SUPPORTED_SPLIT_POLICIES = new Set([
  LEGACY_SPLIT_POLICY,
  HYBRID_SPLIT_POLICY,
  PARAGRAPH_SPLIT_POLICY
]);

function normalizeSplitPolicy(value) {
  const normalized = String(value || LEGACY_SPLIT_POLICY).trim().toLowerCase();
  return SUPPORTED_SPLIT_POLICIES.has(normalized)
    ? normalized
    : LEGACY_SPLIT_POLICY;
}

function splitPolicyVariantSuffix(policy) {
  const normalized = normalizeSplitPolicy(policy);
  if (normalized === PARAGRAPH_SPLIT_POLICY) return ':splitparagraph1';
  return normalized === HYBRID_SPLIT_POLICY
    ? ':splithybrid1'
    : '';
}

function appendPiece(current, piece) {
  if (!current) {
    return {
      text: piece.text,
      paragraphFinal: piece.paragraphFinal,
      segments: [piece],
      lastBlockIndex: piece.blockIndex
    };
  }
  const sameBlock = current.lastBlockIndex === piece.blockIndex;
  current.text += `${sameBlock ? ' ' : '\n\n'}${piece.text}`;
  current.paragraphFinal = piece.paragraphFinal;
  current.segments.push(piece);
  current.lastBlockIndex = piece.blockIndex;
  return current;
}

function appendedLength(current, piece) {
  if (!current) return piece.text.length;
  return current.text.length +
    (current.lastBlockIndex === piece.blockIndex ? 1 : 2) +
    piece.text.length;
}

function packHybridPieces(pieces, {
  firstMaxChars = 420,
  targetChars = 750,
  maxChars = 900,
  minChars = 200
} = {}) {
  const firstLimit = Math.max(20, Math.round(firstMaxChars));
  const continuationMax = Math.max(firstLimit, Math.round(maxChars));
  const continuationTarget = Math.min(
    continuationMax,
    Math.max(firstLimit, Math.round(targetChars))
  );
  const minimum = Math.min(continuationTarget, Math.max(20, Math.round(minChars)));
  const chunks = [];
  let current = null;

  for (const piece of pieces) {
    const firstChunk = chunks.length === 0;
    const limit = firstChunk ? firstLimit : continuationMax;
    if (current && (
      appendedLength(current, piece) > limit ||
      (!firstChunk && current.text.length >= continuationTarget)
    )) {
      chunks.push(current);
      current = null;
    }
    current = appendPiece(current, piece);
  }
  if (current) chunks.push(current);

  for (let index = chunks.length - 1; index > 1; index--) {
    const chunk = chunks[index];
    const previous = chunks[index - 1];
    if (chunk.text.length >= minimum || appendedLength(previous, {
      text: chunk.text,
      blockIndex: chunk.segments[0]?.blockIndex
    }) > continuationMax) {
      continue;
    }
    const separator = previous.lastBlockIndex === chunk.segments[0]?.blockIndex ? ' ' : '\n\n';
    previous.text += separator + chunk.text;
    previous.paragraphFinal = chunk.paragraphFinal;
    previous.segments.push(...chunk.segments);
    previous.lastBlockIndex = chunk.lastBlockIndex;
    chunks.splice(index, 1);
  }

  for (const chunk of chunks) delete chunk.lastBlockIndex;
  return chunks;
}

function planNarrationForPolicy(text, options = {}) {
  const policy = normalizeSplitPolicy(options.policy);
  if (policy === LEGACY_SPLIT_POLICY) {
    return planNarration(text, { maxChars: options.firstMaxChars || options.maxChars || 4000 });
  }

  if (policy === PARAGRAPH_SPLIT_POLICY) {
    const limit = options.firstMaxChars || options.maxChars || 160;
    const structure = buildNarrationPieces(text, limit);
    const chunks = [];
    let current = null;
    for (const piece of structure.pieces) {
      // Nano can stop after the first paragraph of a packed request. Keep
      // paragraphs separate, while attaching heading cues to neighboring prose
      // so a two-word heading does not become an unstable synthesis request.
      const hasProse = current?.segments.some(segment => segment.kind !== 'heading');
      const crossesParagraph = current && current.lastBlockIndex !== piece.blockIndex &&
        hasProse && piece.kind !== 'heading';
      if (current && (crossesParagraph || appendedLength(current, piece) > limit)) {
        chunks.push(current);
        current = null;
      }
      current = appendPiece(current, piece);
    }
    if (current) chunks.push(current);
    for (const chunk of chunks) delete chunk.lastBlockIndex;
    return { text: structure.text, blocks: structure.blocks, chunks };
  }

  const firstMaxChars = options.firstMaxChars || 420;
  const maxChars = options.maxChars || 900;
  const structure = buildNarrationPieces(text, Math.min(firstMaxChars, maxChars));
  return {
    text: structure.text,
    blocks: structure.blocks,
    chunks: packHybridPieces(structure.pieces, {
      ...options,
      firstMaxChars,
      maxChars
    })
  };
}

module.exports = {
  LEGACY_SPLIT_POLICY,
  HYBRID_SPLIT_POLICY,
  PARAGRAPH_SPLIT_POLICY,
  normalizeSplitPolicy,
  splitPolicyVariantSuffix,
  packHybridPieces,
  planNarrationForPolicy
};
