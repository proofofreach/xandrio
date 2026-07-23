export function expandNumericChapterTitle(title) {
  const normalized = String(title || '').replace(/\s+/g, ' ').trim();
  return /^\d+$/.test(normalized) ? `Chapter ${normalized}` : normalized;
}

const COMMON_SENTENCE_ABBREVIATION = /(?:\b(?:vs|mr|mrs|ms|dr|prof|sr|jr|st|no|vol|rev|etc|e\.g|i\.e)|(?:^|\s)[a-z])\.$/i;

export function firstDisplaySentence(text, options = {}) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  const minLength = Number.isFinite(options.minLength) ? options.minLength : 1;
  const maxLength = Number.isFinite(options.maxLength) ? options.maxLength : 80;
  const boundary = /[.!?](?=\s+[A-Z"'])/g;
  let match;

  while ((match = boundary.exec(raw))) {
    const candidate = raw.slice(0, match.index + 1).trim();
    if (candidate.length < minLength) continue;
    if (candidate.length > maxLength) return '';
    if (match[0] === '.' && COMMON_SENTENCE_ABBREVIATION.test(candidate)) continue;
    return candidate;
  }

  return '';
}

const NON_NARRATIVE_TYPES = new Set([
  'cover',
  'copyright',
  'toc',
  'frontmatter',
  'backmatter',
  'author',
  'divider'
]);

function isNarrativeChapter(chapter) {
  return Boolean(chapter && !chapter.empty && !NON_NARRATIVE_TYPES.has(chapter.type));
}

const CARDINAL_CHAPTER_NUMBERS = new Map(Object.entries({
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90
}));

function romanChapterNumber(value) {
  const roman = String(value || '').toUpperCase();
  if (!/^[IVXLCDM]+$/.test(roman)) return null;
  const values = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let total = 0;
  for (let index = 0; index < roman.length; index++) {
    const current = values[roman[index]];
    const next = values[roman[index + 1]] || 0;
    total += current < next ? -current : current;
  }
  return total > 0 ? total : null;
}

function cardinalChapterNumber(words) {
  const tokens = String(words || '').toLowerCase().replace(/-/g, ' ').split(/\s+/).filter(Boolean);
  if (!tokens.length || tokens.length > 2) return null;
  const first = CARDINAL_CHAPTER_NUMBERS.get(tokens[0]);
  if (!first) return null;
  if (tokens.length === 1) return first;
  const second = CARDINAL_CHAPTER_NUMBERS.get(tokens[1]);
  return first >= 20 && first % 10 === 0 && second > 0 && second < 10 ? first + second : null;
}

function chapterNumberFromTitle(title) {
  const normalized = String(title || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  if (/^\d+$/.test(normalized)) return Number(normalized);

  const prefixed = normalized.match(/^(?:chapter|ch\.?)\s+(.+)$/i);
  if (prefixed) {
    const rest = prefixed[1];
    const digit = rest.match(/^(\d+)\b/);
    if (digit) return Number(digit[1]);
    const tokens = rest.split(/\s+/);
    const cardinal = cardinalChapterNumber(tokens.slice(0, 2).join(' ')) || cardinalChapterNumber(tokens[0]);
    if (cardinal) return cardinal;
    const roman = romanChapterNumber(tokens[0]?.replace(/[.:-–—]$/, ''));
    if (roman) return roman;
  }

  const leadingDigit = normalized.match(/^(\d+)(?:[.:-–—]|\s|$)/);
  if (leadingDigit) return Number(leadingDigit[1]);
  const leadingRoman = normalized.match(/^([IVXLCDM]+)[.:-–—](?:\s|$)/i);
  return leadingRoman ? romanChapterNumber(leadingRoman[1]) : null;
}

export function chapterListItemState(index, currentIndex) {
  return Number(index) === Number(currentIndex) ? 'active' : 'available';
}

export function chapterListOrdinal(chapters, currentIndex) {
  const list = Array.isArray(chapters) ? chapters : [];
  const index = Number(currentIndex);
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return '';
  const chapter = list[index];
  if (!chapter || chapter.empty || chapter.type !== 'chapter') return '';
  const authoredNumber = chapterNumberFromTitle(chapter.title);
  if (authoredNumber) return String(authoredNumber).padStart(2, '0');
  const ordinal = list.slice(0, index + 1)
    .filter(item => item && !item.empty && item.type === 'chapter')
    .length;
  return ordinal ? String(ordinal).padStart(2, '0') : '';
}

export function chapterProgressContext(chapters, currentIndex) {
  const list = Array.isArray(chapters) ? chapters : [];
  if (!list.length) return '';
  const index = Math.max(0, Math.min(list.length - 1, Number(currentIndex) || 0));
  const current = list[index];
  const currentNumber = isNarrativeChapter(current) ? chapterNumberFromTitle(current?.title) : null;

  if (currentNumber) {
    const authoredNumbers = list
      .filter(isNarrativeChapter)
      .map(chapter => chapterNumberFromTitle(chapter?.title))
      .filter(Number.isFinite);
    const finalNumber = Math.max(currentNumber, ...authoredNumbers);
    return `Chapter ${currentNumber} of ${finalNumber}`;
  }

  return expandNumericChapterTitle(current?.title) || `Section ${index + 1} of ${list.length}`;
}

function isChapterOneTitle(title = '') {
  const normalized = String(title || '').replace(/\s+/g, ' ').trim();
  return /^chapter\s+(?:1|one|i|the\s+first)\b/i.test(normalized) ||
    /^ch\.?\s*(?:1|one|i)\b/i.test(normalized) ||
    /^(?:1|one|i)(?:[\s.:\-–—]|$)/i.test(normalized);
}

export function findPreferredStartChapterIndex(chapters) {
  const list = Array.isArray(chapters) ? chapters : [];
  let firstNamedChapter = -1;
  let firstContent = -1;

  for (let index = 0; index < list.length; index++) {
    const chapter = list[index] || {};
    if (isChapterOneTitle(chapter.title)) return index;
    if (firstNamedChapter === -1 && chapter.type === 'chapter') firstNamedChapter = index;
    if (firstContent === -1 && isNarrativeChapter(chapter) && String(chapter.text || '').trim().length > 200) {
      firstContent = index;
    }
  }

  if (firstContent !== -1) return firstContent;
  if (firstNamedChapter !== -1) return firstNamedChapter;
  return 0;
}
