// Kokoro's English grapheme-to-phoneme layer treats many unknown ALL-CAPS
// lexical words as initialisms ("JOYCE" becomes J-O-Y-C-E). Converted ebooks
// commonly use casing instead of semantic markup for headings and emphasis, so
// repair long lexical tokens at the shared narration boundary. Known acronyms
// receive the casing that makes Kokoro pronounce them as words; known
// initialisms stay uppercase. Unknown long tokens deliberately fall back to
// normal word casing, which is safer for names and emphasized prose.
const WORD_SPOKEN_ACRONYM_FORMS = new Map([
  ['AIDS', 'Aids'], ['AJAX', 'Ajax'], ['ANSI', 'Ansi'], ['APEC', 'Apec'],
  ['ASEAN', 'Asean'], ['ASCII', 'Ascii'], ['AWOL', 'Awol'], ['BASIC', 'Basic'],
  ['BIOS', 'BIOS'], ['CAPTCHA', 'Captcha'], ['CERN', 'Cern'], ['COBOL', 'Cobol'],
  ['COVID', 'Covid'], ['FEMA', 'Fema'], ['FIFA', 'Fifa'], ['FOIA', 'Foia'],
  ['FOMO', 'Fomo'], ['FORTRAN', 'Fortran'], ['GIF', 'Gif'], ['IMAX', 'IMAX'],
  ['JPEG', 'Jpeg'], ['JSON', 'Json'], ['LASER', 'Laser'], ['MIDI', 'Midi'],
  ['NAFTA', 'Nafta'], ['NASA', 'Nasa'], ['NATO', 'Nato'], ['NOAA', 'Noaa'],
  ['OPEC', 'Opec'], ['OSHA', 'Osha'], ['PETA', 'Peta'], ['RADAR', 'Radar'],
  ['SARS', 'Sars'], ['SCUBA', 'Scuba'], ['SNAFU', 'Snafu'], ['SQL', 'SQL'],
  ['SWAT', 'Swat'], ['UNESCO', 'Unesco'], ['UNICEF', 'Unicef'],
  ['UNIX', 'Unix'], ['WIFI', 'Wifi'], ['WYSIWYG', 'Wysiwyg'], ['YAML', 'Yaml'],
  ['YOLO', 'Yolo']
]);

const LETTER_SPELLED_INITIALISMS = new Set([
  'AARP', 'ACLU', 'ADHD', 'BDSM', 'CCTV', 'COPD', 'DHCP', 'ESPN', 'HDTV',
  'HDMI', 'HTML', 'HTTP', 'HTTPS', 'IEEE', 'ISBN', 'LGBT', 'LGBTQ',
  'LGBTQIA', 'NAACP', 'NCAA', 'NDAA', 'NSFW', 'OECD', 'PTSD', 'RSVP',
  'SMTP', 'UCLA', 'UNHCR', 'USDA', 'USPS', 'USSR', 'UUID', 'XHTML', 'YMCA'
]);

function removeStandaloneOrnaments(text) {
  // EPUB scene breaks and footnote dividers often survive extraction as lines
  // such as "~•~", "* * *", "—", or "§". They carry layout meaning but no
  // spoken content. Restrict removal to whole lines containing only Unicode
  // punctuation/symbols so inline notation and prose remain untouched.
  return String(text || '').replace(
    /^[^\S\r\n]*[\p{P}\p{S}](?:[^\S\r\n]*[\p{P}\p{S}])*[^\S\r\n]*$/gmu,
    ''
  );
}

function normalizeNarrationCasing(text) {
  return String(text || '').replace(
    /(^|[^\p{L}])(\p{Lu}{4,})(['’]S)?(?=$|[^\p{L}])/gu,
    (_match, prefix, word, possessive = '') => {
      if (LETTER_SPELLED_INITIALISMS.has(word) || /^(?:M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3}))$/.test(word)) {
        return `${prefix}${word}${possessive}`;
      }
      const spokenWord = WORD_SPOKEN_ACRONYM_FORMS.get(word) ||
        (word.charAt(0) + word.slice(1).toLocaleLowerCase('en'));
      return `${prefix}${spokenWord}${possessive ? possessive.toLocaleLowerCase('en') : ''}`;
    }
  );
}

function prepareTtsText(text) {
  return normalizeNarrationCasing(removeStandaloneOrnaments(text))
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([,;:!?])(?=[A-Za-z])/g, '$1 ')
    .replace(/\.(?=[A-Z])/g, '. ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isSpeakableText(text) {
  const prepared = prepareTtsText(text);
  if (prepared.length < 20) return false;
  const nonWhitespace = (prepared.match(/\S/g) || []).length;
  const lettersAndNumbers = (prepared.match(/[\p{L}\p{N}]/gu) || []).length;
  if (!nonWhitespace) return false;
  return lettersAndNumbers / nonWhitespace >= 0.55;
}

function splitOversizedText(text, maxChars) {
  const prepared = prepareTtsText(text);
  if (prepared.length <= maxChars) return prepared ? [prepared] : [];

  const chunks = [];
  let remaining = prepared;
  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars + 1);
    let cut = Math.max(
      window.lastIndexOf('. '),
      window.lastIndexOf('? '),
      window.lastIndexOf('! '),
      window.lastIndexOf('; '),
      window.lastIndexOf(', ')
    );
    if (cut < Math.floor(maxChars * 0.5)) {
      cut = window.lastIndexOf(' ');
    }
    if (cut < Math.floor(maxChars * 0.5)) {
      cut = maxChars;
    }
    chunks.push(remaining.slice(0, cut + 1).trim());
    remaining = remaining.slice(cut + 1).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks.filter(Boolean);
}

const NON_TERMINAL_ABBREVIATIONS = new Set([
  'dr.', 'mr.', 'mrs.', 'ms.', 'prof.', 'sr.', 'jr.', 'st.', 'mt.',
  'vs.', 'fig.', 'no.', 'vol.', 'ch.', 'pp.', 'rev.', 'hon.'
]);

function splitNarrationSentences(text) {
  const value = prepareTtsText(text).replace(/\n+/g, ' ').trim();
  if (!value) return [];

  const sentences = [];
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    if (!'.!?'.includes(value[i])) continue;

    const previous = value[i - 1] || '';
    const next = value[i + 1] || '';
    if (value[i] === '.' && /\d/.test(previous) && /\d/.test(next)) continue;

    const prefix = value.slice(start, i + 1);
    const token = (prefix.match(/(?:^|\s)([^\s]+)$/) || [])[1]?.toLowerCase() || '';
    if (value[i] === '.' && (NON_TERMINAL_ABBREVIATIONS.has(token) || /^[a-z]\.$/i.test(token))) {
      continue;
    }

    // Consume repeated punctuation and closing quotation/bracket characters.
    let end = i + 1;
    while (/[.!?]/.test(value[end] || '')) end++;
    while (/['"’”\)\]]/.test(value[end] || '')) end++;
    if (end < value.length && !/\s/.test(value[end])) continue;

    const sentence = value.slice(start, end).trim();
    if (sentence) sentences.push(sentence);
    while (/\s/.test(value[end] || '')) end++;
    start = end;
    i = end - 1;
  }

  const remainder = value.slice(start).trim();
  if (remainder) sentences.push(remainder);
  return sentences;
}

function isNarrationHeading(text) {
  const value = String(text || '').trim();
  if (!value || value.length > 100 || /[.!?]$/.test(value)) return false;
  const words = value.split(/\s+/);
  if (words.length > 12) return false;
  return /^(chapter|book|part|section|prologue|epilogue|introduction|preface|table[t]?|act)\b/i.test(value) ||
    (/[\p{L}]/u.test(value) && value === value.toUpperCase());
}

function isDialogueSentence(text) {
  const value = String(text || '').trim();
  return /^[“"‘']/.test(value) || /[“"][^”"]+[”"]/.test(value);
}

/**
 * Build an engine-neutral narration plan before voice-specific adaptation.
 * Structural blocks and sentence boundaries are retained so chunking never
 * has to rediscover them with an engine-specific regular expression.
 */
function planNarration(text, { maxChars = 4000 } = {}) {
  const prepared = prepareTtsText(text);
  if (!prepared || !isSpeakableText(prepared)) return { text: prepared, blocks: [], chunks: [] };

  const blocks = prepared.split(/\n\s*\n/).map(value => value.trim()).filter(Boolean).map((value, index) => {
    const kind = isNarrationHeading(value) ? 'heading' : 'paragraph';
    return {
      index,
      kind,
      text: value,
      sentences: kind === 'heading' ? [value] : splitNarrationSentences(value)
    };
  });

  const pieces = [];
  for (const block of blocks) {
    const sentences = block.sentences.length ? block.sentences : [block.text];
    for (let sentenceIndex = 0; sentenceIndex < sentences.length; sentenceIndex++) {
      const parts = splitOversizedText(sentences[sentenceIndex], maxChars);
      for (let partIndex = 0; partIndex < parts.length; partIndex++) {
        pieces.push({
          text: parts[partIndex],
          kind: block.kind === 'paragraph' && isDialogueSentence(sentences[sentenceIndex]) ? 'dialogue' : block.kind,
          blockIndex: block.index,
          sentenceIndex,
          paragraphFinal: sentenceIndex === sentences.length - 1 && partIndex === parts.length - 1,
          pauseIntent: block.kind === 'heading'
            ? 'heading'
            : (sentenceIndex === sentences.length - 1 && partIndex === parts.length - 1 ? 'paragraph' : 'sentence')
        });
      }
    }
  }

  const chunks = [];
  let current = null;
  for (const piece of pieces) {
    const sameBlock = current && current.lastBlockIndex === piece.blockIndex;
    const separator = !current ? '' : (sameBlock ? ' ' : '\n\n');
    if (current && current.text.length + separator.length + piece.text.length > maxChars) {
      chunks.push(current);
      current = null;
    }
    if (!current) {
      current = {
        text: piece.text,
        paragraphFinal: piece.paragraphFinal,
        segments: [piece],
        lastBlockIndex: piece.blockIndex
      };
    } else {
      current.text += separator + piece.text;
      current.paragraphFinal = piece.paragraphFinal;
      current.segments.push(piece);
      current.lastBlockIndex = piece.blockIndex;
    }
  }
  if (current) chunks.push(current);
  for (const chunk of chunks) delete chunk.lastBlockIndex;

  return { text: prepared, blocks, chunks };
}

module.exports = {
  prepareTtsText,
  isSpeakableText,
  splitOversizedText,
  splitNarrationSentences,
  isNarrationHeading,
  isDialogueSentence,
  planNarration
};
