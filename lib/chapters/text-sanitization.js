const {
  ALLOWED_TEXT_MUTATIONS,
  mutationActivation
} = require('../extraction-result');

const ROMAN_NUMERAL_RE = /^(?:M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3}))$/;
const PRESERVE_WORDS = new Set(['US', 'UK', 'FBI', 'CIA', 'NASA', 'DNA', 'PhD', 'CEO', 'USA', 'USSR', 'NYC', 'LA', 'DC', 'AI', 'TV', 'BBC', 'MIT', 'MBA', 'UN', 'EU', 'WHO', 'NATO']);

function normalizePlainText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function estimateDuration(text) {
  return Math.ceil(String(text || '').length / 1000 * 60);
}

function replaceRegistered(text, pattern, replacer, policy, options = {}) {
  let count = 0;
  const result = String(text || '').replace(pattern, (...args) => {
    const replacement = replacer(...args);
    if (replacement !== args[0]) count++;
    return replacement;
  });
  if (count > 0) {
    const activation = mutationActivation({ code: policy.code, count });
    options.mutationRecorder?.(activation);
  }
  return result;
}

function repairTextArtifacts(text, options = {}) {
  let repaired = replaceRegistered(
    text,
    /[­​‌‍﻿]/g,
    () => '',
    ALLOWED_TEXT_MUTATIONS.INVISIBLE_CHARACTER_REMOVAL,
    options
  );
  repaired = replaceRegistered(
    repaired,
    // Ebook markup sometimes drops the only whitespace after a contraction
    // or possessive ("it'scalled", "author'sbook").
    /([’'](?:s|t|d|m|re|ve|ll))(?=[a-z])/gi,
    (_match, contraction) => `${contraction} `,
    ALLOWED_TEXT_MUTATIONS.WHITESPACE_NORMALIZATION,
    options
  );
  repaired = replaceRegistered(
    repaired,
    // Printed page numbers can be fused to a Roman-numeral chapter heading
    // during ebook conversion ("XXIX 32"). Keep the authored marker but drop
    // the page furniture before title recovery and narration hashing.
    /^([IVXLCDM]+)[ \t]+\d{1,4}[ \t]*(?=\r?$)/gimu,
    (_match, numeral) => numeral,
    ALLOWED_TEXT_MUTATIONS.SEMANTIC_PAGE_MARKER_REMOVAL,
    options
  );
  return replaceRegistered(
    repaired,
    /([A-Za-z])-[ \t]+(?!(?:and|or|to|nor|but)\b)(?=[a-z])/g,
    (_match, letter) => `${letter}-`,
    ALLOWED_TEXT_MUTATIONS.WHITESPACE_NORMALIZATION,
    options
  );
}

function isRawTextTagBoundary(character) {
  return character === '>' || character === '/' ||
    character === ' ' || character === '\t' || character === '\n' ||
    character === '\r' || character === '\f';
}

function rawTextTagAt(source, index, closing, expectedName = null) {
  if (source[index] !== '<') return null;
  let nameStart = index + 1;
  if (closing) {
    if (source[nameStart] !== '/') return null;
    nameStart += 1;
  } else if (source[nameStart] === '/') {
    return null;
  }

  const names = expectedName ? [expectedName] : ['script', 'style'];
  for (const name of names) {
    if (source.slice(nameStart, nameStart + name.length).toLowerCase() !== name) continue;
    if (isRawTextTagBoundary(source[nameStart + name.length])) return { index, name };
  }
  return null;
}

function tagEnd(source, start) {
  let quote = null;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return -1;
}

function nextRawTextTag(source, start, closing, expectedName = null) {
  let index = source.indexOf('<', start);
  while (index !== -1) {
    const tag = rawTextTagAt(source, index, closing, expectedName);
    if (tag) return tag;
    index = source.indexOf('<', index + 1);
  }
  return null;
}

function removeRawTextElements(value, options = {}) {
  const source = String(value || '');
  const retained = [];
  let cursor = 0;
  let searchFrom = 0;
  let count = 0;

  while (searchFrom < source.length) {
    const opening = nextRawTextTag(source, searchFrom, false);
    if (!opening) break;
    const openingEnd = tagEnd(source, opening.index);
    if (openingEnd === -1) break;

    retained.push(source.slice(cursor, opening.index));
    const closing = nextRawTextTag(source, openingEnd + 1, true, opening.name);
    if (!closing) {
      cursor = source.length;
      count += 1;
      break;
    }
    const closingEnd = tagEnd(source, closing.index);
    cursor = closingEnd === -1 ? source.length : closingEnd + 1;
    searchFrom = cursor;
    count += 1;
  }

  retained.push(source.slice(cursor));
  if (count > 0) {
    options.mutationRecorder?.(mutationActivation({
      code: ALLOWED_TEXT_MUTATIONS.RECOGNIZED_BOILERPLATE_REMOVAL.code,
      count
    }));
  }
  return retained.join('');
}

function stripHTML(html, options = {}) {
  let text = removeRawTextElements(html, options);
  text = replaceRegistered(
    text,
    // EPUB 3 page-list anchors expose printed pagination to navigation, not
    // narration. Remove their contents while the semantic attributes still
    // exist; the generic tag stripper below cannot distinguish them later.
    /<(?:span|a|div|p)\b(?=[^>]*(?:epub:type|role)\s*=\s*["'][^"']*(?:pagebreak|doc-pagebreak)[^"']*["'])[^>]*\/\s*>/gi,
    () => '',
    ALLOWED_TEXT_MUTATIONS.SEMANTIC_PAGE_MARKER_REMOVAL,
    options
  );
  text = replaceRegistered(
    text,
    /<(span|a|div|p)\b(?=[^>]*(?:epub:type|role)\s*=\s*["'][^"']*(?:pagebreak|doc-pagebreak)[^"']*["'])[^>]*>[\s\S]*?<\/\1\s*>/gi,
    () => '',
    ALLOWED_TEXT_MUTATIONS.SEMANTIC_PAGE_MARKER_REMOVAL,
    options
  );
  text = replaceRegistered(
    text,
    // Invisible characters: soft hyphens (literal and entity forms) and
    // zero-width chars split words for TTS engines while being
    // unrenderable for readers. Must run before entity decoding, or
    // &shy; falls through to the generic entity→space rule mid-word.
    /[­​‌‍﻿]|&shy;|&#173;|&#xad;/gi,
    () => '',
    ALLOWED_TEXT_MUTATIONS.INVISIBLE_CHARACTER_REMOVAL,
    options
  );
  text = replaceRegistered(
    text,
    // Data tables narrate as an unlistenable number stream. Drop tables
    // where at least half the cells are numeric; keep prose laid out in
    // tables (verse, dialogue, layout tables) intact.
    /<table[^>]*>[\s\S]*?<\/table>/gi,
    (table) => {
      const cells = [...table.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
        .map(m => m[1].replace(/<[^>]+>/g, ' ').trim())
        .filter(Boolean);
      if (cells.length < 4) return table;
      const numericCells = cells.filter(c => /^[\d\s.,:;%°'′″/⁄½¼¾¾+±()-]+$/u.test(c)).length;
      return numericCells / cells.length >= 0.5 ? '\n' : table;
    },
    ALLOWED_TEXT_MUTATIONS.RECOGNIZED_BOILERPLATE_REMOVAL,
    options
  );
  text = replaceRegistered(
    text,
    // A source line wrap after a hyphen (with or without trailing space)
    // splits a compound word ("self- \ncriticism"); rejoin it — unless the
    // next word is a coordination ("copper- and iron-tipped"), where the
    // suspended hyphen's space is real.
    /-[ \t]*[\r\n]+[ \t]*(?!(?:and|or|to|nor|but)\b)(?=[a-z])/g,
    () => '-',
    ALLOWED_TEXT_MUTATIONS.LINE_WRAP_DEHYPHENATION,
    options
  );
  text = replaceRegistered(
    text,
    // HTML source whitespace collapses like a browser renders it: newlines
    // inside text (pretty-printed/hard-wrapped XHTML) are just spaces. Real
    // line breaks come only from the block-tag and <br> rules below —
    // otherwise mid-sentence source wraps become audible TTS pauses.
    /[\r\n\t\f\v]+/g,
    () => ' ',
    ALLOWED_TEXT_MUTATIONS.WHITESPACE_NORMALIZATION,
    options
  );
  text = text
    // Inline formatting tags that split a word — drop caps (<span>K</span>al)
    // and mid-word emphasis (im<i>possible</i>). Browsers render these with
    // no space at the tag boundary, so remove the tags instead of replacing
    // them with a space (which produced "K al", "T ony" chapter openings).
    // Only fires when the tag run sits directly between a letter (or a
    // hyphen: "self-</span>criticism") and a lowercase letter, so normal
    // inter-word markup is untouched.
    .replace(/([A-Za-z-])(?:<\/?(?:span|a|b|i|em|strong|u|s|small|big|sup|sub|font|abbr|cite|q|code)(?:\s[^>]*)?>)+(?=[a-z])/g, '$1')
    .replace(/<\/(p|div|h[1-6]|li|br\s*\/?)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#160;/gi, ' ')
    .replace(/&bull;/gi, '•')
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&hellip;/gi, '...')
    .replace(/&rsquo;/gi, "'")
    .replace(/&lsquo;/gi, "'")
    .replace(/&rdquo;/gi, '"')
    .replace(/&ldquo;/gi, '"')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : ' ';
    })
    .replace(/&#(\d+);/g, (_match, dec) => {
      const code = parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : ' ';
    })
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/<\/?[a-z][a-z0-9]*(\s[^>]*)?\s*>/gi, ' ')
    // Literal no-break spaces (common in RTF/Word conversions) — treat as
    // plain spaces so the whitespace rules below see them.
    .replace(/\u00a0/g, ' ');
  text = replaceRegistered(
    text,
    // Letter-by-letter spaced caps ("W I N N I E" → "WINNIE"): require a run
    // of 3+ single capitals so real words ("A Canticle") are never joined.
    /\b[A-Z](?:\s+[A-Z]\b){2,}(?![a-z])/g,
    match => match.replace(/\s+/g, ''),
    ALLOWED_TEXT_MUTATIONS.SPACED_CAPS_NORMALIZATION,
    options
  );
  text = replaceRegistered(
    text,
    // Styled small-caps first letter ("W INNIE" → "WINNIE"). Exclude A/I,
    // which are legitimate single-letter English words ("A CANTICLE", "I AM").
    /\b([B-HJ-Z])\s+([A-Z]{2,})\b/g,
    (_match, first, rest) => `${first}${rest}`,
    ALLOWED_TEXT_MUTATIONS.SPACED_CAPS_NORMALIZATION,
    options
  );
  text = replaceRegistered(text, /([A-Z])-\s+([A-Z])/g, (_match, left, right) => `${left}-${right}`,
    ALLOWED_TEXT_MUTATIONS.WHITESPACE_NORMALIZATION, options);
  text = replaceRegistered(text, /[ \t]+/g, () => ' ',
    ALLOWED_TEXT_MUTATIONS.WHITESPACE_NORMALIZATION, options);
  text = replaceRegistered(text, /\n\s*\n/g, () => '\n\n',
    ALLOWED_TEXT_MUTATIONS.WHITESPACE_NORMALIZATION, options);
  text = replaceRegistered(
    text,
    // Drop-cap repair: a lone capital on its own line (optionally preceded by
    // an opening quote) whose word continues lowercase on the next line —
    // produced by drop-cap markup like <td><span>B</span></td>...<p>rother...
    /(^|\n)([ \t]*["“'‘]?[ \t]*)([A-Z])[ \t]*\n+[ \t]*(?=[a-z])/g,
    (_match, boundary, quote, letter) => `${boundary}${quote}${letter}`,
    ALLOWED_TEXT_MUTATIONS.WHITESPACE_NORMALIZATION,
    options
  );
  text = replaceRegistered(
    text,
    // Digit headings split across spans ("2 4" alone on a line → "24")
    /(^|\n)[ \t]*(\d(?:[ \t]+\d)+)[ \t]*(?=\n|$)/g,
    (_match, boundary, digits) => boundary + digits.replace(/[ \t]+/g, ''),
    ALLOWED_TEXT_MUTATIONS.WHITESPACE_NORMALIZATION,
    options
  );
  text = replaceRegistered(text, /^\s+|\s+$/gu, () => '',
    ALLOWED_TEXT_MUTATIONS.WHITESPACE_NORMALIZATION, options);
  return repairTextArtifacts(text, options);
}

// Helper: Normalize ALL-CAPS titles to Title Case
function normalizeAllCapsTitle(title) {
  if (!title) return title;
  const alpha = title.replace(/[^a-zA-Z]/g, '');
  if (alpha.length < 2) return title;
  const upperCount = (alpha.match(/[A-Z]/g) || []).length;
  if (upperCount / alpha.length <= 0.8) return title;

  return title.replace(/\S+/g, (word) => {
    const stripped = word.replace(/[^a-zA-Z]/g, '');
    if (ROMAN_NUMERAL_RE.test(stripped) && stripped.length > 0) return word;
    if (PRESERVE_WORDS.has(stripped)) return word;
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  });
}

module.exports = {
  normalizePlainText,
  estimateDuration,
  repairTextArtifacts,
  stripHTML,
  normalizeAllCapsTitle
};
