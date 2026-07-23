const { createEngineProfile } = require('./tts-engine-profile');

const PROFILES = Object.freeze({
  quality: {
    name: 'quality',
    chunkSize: 420,
    maxConcurrent: 1,
    description: 'Shortest chunks and most conservative pacing for audiobook listening.'
  },
  balanced: {
    name: 'balanced',
    chunkSize: 600,
    maxConcurrent: 1,
    description: 'Reliable long-form narration with moderate chunk sizes.'
  },
  fast: {
    name: 'fast',
    chunkSize: 900,
    maxConcurrent: 1,
    description: 'Larger chunks for faster background generation when quality is acceptable.'
  }
});

const VOICE_OVERRIDES = Object.freeze({
  af_heart: { balanced: 560, quality: 420, fast: 840 },
  af_bella: { balanced: 520, quality: 400, fast: 800 },
  am_adam: { balanced: 620, quality: 460, fast: 900 },
  am_michael: { balanced: 580, quality: 440, fast: 860 },
  bm_george: { balanced: 560, quality: 420, fast: 840 },
  bm_lewis: { balanced: 600, quality: 450, fast: 880 }
});

const engine = createEngineProfile({
  idPrefix: 'kokoro:',
  envPrefix: 'KOKORO',
  profiles: PROFILES,
  voiceOverrides: VOICE_OVERRIDES,
  defaultProfile: 'quality'
});

const isKokoroVoice = engine.isVoice;
const getKokoroVoiceName = engine.getVoiceName;
const normalizeKokoroProfile = engine.normalizeProfile;
const getKokoroProfileConfig = engine.getProfileConfig;
const getKokoroChunkSize = engine.getChunkSize;
const getKokoroVariantKey = engine.getVariantKey;
const getKokoroConcurrency = engine.getConcurrency;

function emptyDiagnostics() {
  return {
    quoteSpacingFixes: 0,
    punctuationSpacingFixes: 0,
    repeatedPunctuationFixes: 0,
    headingPauseFixes: 0,
    paragraphPauseFixes: 0,
    whitespaceFixes: 0
  };
}

function cleanQuoteSpacing(text, diagnostics) {
  const before = text;
  let result = text
    .replace(/\s+([”’"'])/g, '$1')
    .replace(/([“‘"'])\s+/g, '$1');
  if (result !== before) diagnostics.quoteSpacingFixes++;
  return result;
}

function cleanPunctuationSpacing(text, diagnostics) {
  const before = text;
  let result = text
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([,.;:!?])(?=\S)/g, '$1 ')
    .replace(/\s+([)\]}])/g, '$1')
    .replace(/([([{])\s+/g, '$1');
  if (result !== before) diagnostics.punctuationSpacingFixes++;
  return result;
}

function cleanRepeatedPunctuation(text, diagnostics) {
  const before = text;
  let result = text
    .replace(/(?:\.\s*){4,}/g, '...')
    .replace(/\.{4,}/g, '...')
    .replace(/!{2,}/g, '!')
    .replace(/\?{2,}/g, '?')
    .replace(/([,;:])\1+/g, '$1');
  if (result !== before) diagnostics.repeatedPunctuationFixes++;
  return result;
}

function normalizeHeadingPauses(text, diagnostics) {
  const lines = text.split('\n');
  const output = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const next = lines[i + 1]?.trim() || '';
    output.push(lines[i]);
    if (isShortHeading(line) && next && lines[i + 1] !== '') {
      output.push('');
      diagnostics.headingPauseFixes++;
    }
  }
  return output.join('\n');
}

function isShortHeading(line) {
  if (!line || line.length > 80) return false;
  if (/[.!?]$/.test(line)) return false;
  return /^(?:chapter|part|book|\d+\.?|[ivxlcdm]+\.?)\b/i.test(line) || /^[A-Z][A-Za-z0-9 ,:'-]{2,60}$/.test(line);
}

function normalizeParagraphPauses(text, diagnostics) {
  const before = text;
  const result = text
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
  if (result !== before) diagnostics.paragraphPauseFixes++;
  return result;
}

function cleanWhitespace(text, diagnostics) {
  const before = text;
  const result = text.replace(/[ \t]{2,}/g, ' ').trim();
  if (result !== before) diagnostics.whitespaceFixes++;
  return result;
}

function prepareKokoroText(text, options = {}) {
  const diagnostics = emptyDiagnostics();
  let result = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  result = cleanQuoteSpacing(result, diagnostics);
  result = cleanPunctuationSpacing(result, diagnostics);
  result = cleanRepeatedPunctuation(result, diagnostics);
  if (options.headingPauses !== false) {
    result = normalizeHeadingPauses(result, diagnostics);
  }
  result = normalizeParagraphPauses(result, diagnostics);
  result = cleanWhitespace(result, diagnostics);
  return { text: result, diagnostics };
}

module.exports = {
  PROFILES,
  isKokoroVoice,
  getKokoroVoiceName,
  normalizeKokoroProfile,
  getKokoroProfileConfig,
  getKokoroChunkSize,
  getKokoroVariantKey,
  getKokoroConcurrency,
  prepareKokoroText
};
