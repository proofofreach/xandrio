const { reprocessPdfSourceDocument } = require('./pdf-extraction');
const crypto = require('crypto');
const { assessNarration } = require('./extraction-result');

function exactNarrationIntegrity(chapters = []) {
  const text = (chapters || []).map(chapter => String(chapter?.text || '')).join('\n\n');
  return {
    chars: text.length,
    hash: crypto.createHash('sha256').update(text, 'utf8').digest('hex')
  };
}

async function proveArtifactRecovery({
  sourceFormat,
  acceptedChapters = [],
  sourceDocument,
  rebuildPdf = reprocessPdfSourceDocument
} = {}) {
  if (String(sourceFormat || '').toUpperCase() !== 'PDF' || !sourceDocument?.pages?.length) {
    return { proven: false, reason: 'recovery-data-unavailable' };
  }

  let rebuilt;
  try {
    // Serialize the retained source document first. This prevents a proof from
    // accidentally depending on references or transient extraction state that
    // will not survive in the XBook artifact.
    const retainedSource = JSON.parse(JSON.stringify(sourceDocument));
    rebuilt = await rebuildPdf(retainedSource, { warn: false });
  } catch (error) {
    return { proven: false, reason: `round-trip-failed:${error.code || error.name || 'error'}` };
  }

  const acceptedIntegrity = exactNarrationIntegrity(acceptedChapters);
  const rebuiltIntegrity = exactNarrationIntegrity(rebuilt);
  if (
    acceptedIntegrity.hash !== rebuiltIntegrity.hash ||
    acceptedIntegrity.chars !== rebuiltIntegrity.chars
  ) {
    return {
      proven: false,
      reason: 'round-trip-text-mismatch',
      acceptedIntegrity,
      rebuiltIntegrity
    };
  }
  const narration = assessNarration(rebuilt);
  if (!narration.valid) {
    return { proven: false, reason: 'round-trip-not-narratable', rebuiltIntegrity, narration };
  }
  return {
    proven: true,
    reason: 'round-trip-equivalent',
    acceptedIntegrity,
    rebuiltIntegrity,
    narration
  };
}

module.exports = { exactNarrationIntegrity, proveArtifactRecovery };
