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
    const roman = romanChapterNumber(tokens[0]?.replace(/[.:\-–—]$/, ''));
    if (roman) return roman;
  }

  const leadingDigit = normalized.match(/^(\d+)(?:[.:\-–—]|\s|$)/);
  if (leadingDigit) return Number(leadingDigit[1]);
  const leadingRoman = normalized.match(/^([IVXLCDM]+)[.:\-–—](?:\s|$)/i);
  return leadingRoman ? romanChapterNumber(leadingRoman[1]) : null;
}

export function chapterListItemState(index, currentIndex) {
  return Number(index) === Number(currentIndex) ? 'active' : 'available';
}

// ---- The one chapter numbering rule ----------------------------------------
// Every surface that numbers chapters (the player's chapter row, the chapter
// sheet, the mini player, the Recent sheet, the Continue strip and library
// rows) uses chapterNumbering(), so a book never reads "Section 8 of 62" in
// one place and "50 chapters" in another.
//
//   1. Authored numbers win when they are trustworthy: at least one narrative
//      chapter carries a number in its title ("Chapter Two", "12", "XX ...")
//      and those numbers strictly increase through the book. The number is
//      the authored one and the total is the highest authored number.
//      Unnumbered narrative pieces (Prologue, Interlude) keep their own name.
//   2. Otherwise (no authored numbers, or numbering that restarts per part,
//      as in "Part II — Chapter 1"), chapters are counted in reading order:
//      the items typed `chapter` when the book has any, else every narrative
//      item. The total is that count.
//   3. Front and back matter, contents, dividers and empty sections never get
//      a number; they are shown by name.
//
// Returns { mode: 'authored' | 'ordinal', total, numbers } where numbers[i]
// is the displayed number for index i, or null.
const numberingCache = new WeakMap();

export function chapterNumbering(chapters) {
  const list = Array.isArray(chapters) ? chapters : [];
  const cached = numberingCache.get(list);
  if (cached && cached.length === list.length) return cached.result;
  const numbers = new Array(list.length).fill(null);
  const narrative = [];
  list.forEach((chapter, index) => { if (isNarrativeChapter(chapter)) narrative.push(index); });

  const authored = narrative
    .map(index => ({ index, number: chapterNumberFromTitle(list[index]?.title) }))
    .filter(entry => Number.isFinite(entry.number) && entry.number > 0);
  const increasing = authored.length > 0 &&
    authored.every((entry, position) => position === 0 || entry.number > authored[position - 1].number);

  let result;
  if (increasing) {
    authored.forEach(entry => { numbers[entry.index] = entry.number; });
    result = { mode: 'authored', total: authored[authored.length - 1].number, numbers };
  } else {
    const typed = narrative.filter(index => list[index]?.type === 'chapter');
    const counted = typed.length ? typed : narrative;
    counted.forEach((index, position) => { numbers[index] = position + 1; });
    result = { mode: 'ordinal', total: counted.length, numbers };
  }
  if (list.length) numberingCache.set(list, { length: list.length, result });
  return result;
}

// The book's chapter count under the same rule: a library row says
// "34 chapters" where the player says "Chapter 12 of 34".
export function chapterTotal(chapters) {
  return chapterNumbering(chapters).total;
}

// The position label for one index under the rule above.
//   "Chapter 12 of 50"  (default: the player's chapter row)
//   "Ch 12 of 50"       ({ short: true }: mini player)
//   "Ch 12"             ({ short: true, withTotal: false }: Continue, Recent)
// An unnumbered section returns its own name ("Prologue", "Copyright").
export function chapterPositionLabel(chapters, currentIndex, { short = false, withTotal = true } = {}) {
  const list = Array.isArray(chapters) ? chapters : [];
  if (!list.length) return '';
  const index = Math.max(0, Math.min(list.length - 1, Number(currentIndex) || 0));
  const { numbers, total } = chapterNumbering(list);
  const number = numbers[index];
  if (number) {
    const word = short ? 'Ch' : 'Chapter';
    return withTotal ? `${word} ${number} of ${total}` : `${word} ${number}`;
  }
  return expandNumericChapterTitle(list[index]?.title) || `Section ${index + 1}`;
}

// The chapter sheet's number column ("01"), same rule.
export function chapterListOrdinal(chapters, currentIndex) {
  const list = Array.isArray(chapters) ? chapters : [];
  const index = Number(currentIndex);
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return '';
  const number = chapterNumbering(list).numbers[index];
  return number ? String(number).padStart(2, '0') : '';
}

export function chapterProgressContext(chapters, currentIndex) {
  return chapterPositionLabel(chapters, currentIndex);
}

// The resume-point label every compact surface uses (Continue strip,
// Recent sheet): the mini player's "Ch 12 of 50" without the total.
export function chapterResumeLabel(chapters, currentIndex) {
  return chapterPositionLabel(chapters, currentIndex, { short: true, withTotal: false });
}

// ---- Shared part prefixes ------------------------------------------------------
// "Part I: Sick Kids — Chapter 1", "Part I: Sick Kids — Chapter 2": when
// neighbouring listed rows start with the same name followed by a separator
// (" — ", " – ", " - " or ": "), the chapter sheet shows that name once as a
// group heading and each row keeps only the rest. Returns, per index,
// { heading, rest } or null. Empty sections are skipped when finding
// neighbours; a heading needs at least two rows.
const TITLE_SEPARATOR = /\s+[—–-]\s+|:\s+/g;

function titlePrefixCandidates(title) {
  const raw = String(title || '').replace(/\s+/g, ' ').trim();
  const candidates = [];
  for (const match of raw.matchAll(TITLE_SEPARATOR)) {
    const heading = raw.slice(0, match.index).trim();
    const rest = raw.slice(match.index + match[0].length).trim();
    if (heading && rest) candidates.push({ heading, rest });
  }
  return candidates.reverse(); // longest heading first
}

export function sharedTitlePrefixes(chapters) {
  const list = Array.isArray(chapters) ? chapters : [];
  const result = new Array(list.length).fill(null);
  const listed = [];
  list.forEach((chapter, index) => { if (chapter && !chapter.empty) listed.push(index); });
  const candidates = listed.map(index => titlePrefixCandidates(list[index]?.title));
  const shares = (position, heading) => Boolean(candidates[position]?.some(candidate => candidate.heading === heading));
  const chosen = candidates.map((own, position) => own.find(candidate =>
    shares(position - 1, candidate.heading) || shares(position + 1, candidate.heading)) || null);
  // A row keeps its heading only when a neighbour chose the same one, so a
  // lone "Part I: Y" next to a "Part I: X" run does not open a one-row group.
  let changed = true;
  while (changed) {
    changed = false;
    chosen.forEach((match, position) => {
      if (!match) return;
      const paired = chosen[position - 1]?.heading === match.heading || chosen[position + 1]?.heading === match.heading;
      if (!paired) { chosen[position] = null; changed = true; }
    });
  }
  listed.forEach((index, position) => { result[index] = chosen[position]; });
  return result;
}

// Labels for every index, trimmed for storage in the per-book meta cache
// so the library can label resume points without loading the book.
export function chapterResumeLabels(chapters, maxLength = 28) {
  const list = Array.isArray(chapters) ? chapters : [];
  return list.map((_, index) => {
    const label = chapterResumeLabel(list, index);
    return label.length > maxLength ? `${label.slice(0, maxLength - 1).trimEnd()}…` : label;
  });
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

const CHAPTER_TYPE_LABELS = {
  frontmatter: 'Front matter',
  backmatter: 'Back matter',
  copyright: 'Copyright',
  toc: 'Contents',
  divider: 'Divider',
  cover: 'Cover',
  author: 'About the author',
  'pdf-page-group': 'Pages'
};

export function friendlyChapterType(type) {
  const key = String(type || '').trim().toLowerCase();
  if (!key) return '';
  if (CHAPTER_TYPE_LABELS[key]) return CHAPTER_TYPE_LABELS[key];
  const words = key.replace(/[-_]+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
