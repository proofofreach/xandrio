// One spelling for a book's language. EPUB `dc:language`, PDF info, catalogs
// and search providers hand over `en-US`, `EN`, `eng`, `English` or
// `[eng] English` for the same language. Every narration consumer compares
// the base ISO 639-1 code, so the stored value is that base code. The region
// is dropped on purpose: for English it is the voice, not the book, that
// decides the accent (see narrationLanguageForVoice in tts-engine-adapters).

const LANGUAGE_ALIASES = Object.freeze({
  en: 'en', eng: 'en', english: 'en',
  de: 'de', ger: 'de', deu: 'de', german: 'de', deutsch: 'de',
  es: 'es', spa: 'es', spanish: 'es', espanol: 'es', castellano: 'es',
  fr: 'fr', fre: 'fr', fra: 'fr', french: 'fr', francais: 'fr',
  it: 'it', ita: 'it', italian: 'it', italiano: 'it',
  pt: 'pt', por: 'pt', portuguese: 'pt', portugues: 'pt',
  ru: 'ru', rus: 'ru', russian: 'ru',
  zh: 'zh', chi: 'zh', zho: 'zh', chinese: 'zh', cmn: 'zh',
  ja: 'ja', jpn: 'ja', japanese: 'ja',
  nl: 'nl', dut: 'nl', nld: 'nl', dutch: 'nl',
  sv: 'sv', swe: 'sv', swedish: 'sv',
  da: 'da', dan: 'da', danish: 'da',
  no: 'no', nor: 'no', nob: 'no', nb: 'no', norwegian: 'no',
  fi: 'fi', fin: 'fi', finnish: 'fi',
  pl: 'pl', pol: 'pl', polish: 'pl',
  tr: 'tr', tur: 'tr', turkish: 'tr',
  ko: 'ko', kor: 'ko', korean: 'ko',
  ar: 'ar', ara: 'ar', arabic: 'ar',
  he: 'he', heb: 'he', hebrew: 'he', iw: 'he',
  hi: 'hi', hin: 'hi', hindi: 'hi',
  el: 'el', gre: 'el', ell: 'el', greek: 'el'
});

/**
 * Base language code for any common spelling, or '' when the value is empty.
 * Unknown values keep their lowercased primary subtag so nothing is invented.
 */
function normalizeLanguageCode(value) {
  const raw = String(value ?? '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .trim()
    .toLowerCase();
  if (!raw) return '';
  const bracketCode = raw.match(/\[([a-z]{2,3})\]/);
  const first = (bracketCode?.[1] || raw)
    .replace(/^\/languages\//, '')
    .replace(/_/g, '-')
    .replace(/[^a-z-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .find(Boolean) || raw;
  const code = first.split('-')[0];
  return LANGUAGE_ALIASES[code] || LANGUAGE_ALIASES[raw] || code;
}

/** The record with its language in canonical form; other fields untouched. */
function normalizeBookLanguage(book) {
  if (!book || typeof book !== 'object' || typeof book.language !== 'string') return book;
  const language = normalizeLanguageCode(book.language);
  if (language === book.language) return book;
  book.language = language;
  return book;
}

/** Normalize every record of a books.json map in place and return it. */
function normalizeLibraryLanguages(books) {
  if (!books || typeof books !== 'object' || Array.isArray(books)) return books;
  for (const book of Object.values(books)) normalizeBookLanguage(book);
  return books;
}

module.exports = {
  normalizeLanguageCode,
  normalizeBookLanguage,
  normalizeLibraryLanguages
};
