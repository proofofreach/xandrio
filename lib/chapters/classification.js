const {
  repairTextArtifacts,
  stripHTML,
  normalizeAllCapsTitle
} = require('./text-sanitization');

const FILLER_TITLE_PATTERNS = [
  /^(cover|covers?)$/i,
  /^title\s?page$/i,
  /^copyright(\s+page)?$/i,
  /^table\s+of\s+contents$/i,
  /^contents$/i,
  /^about\s+(the\s+)?(author|authors?)$/i,
  /^about\s+this\s+book$/i,
  /^dedication(s)?$/i,
  /^acknowledgment(s)?$/i,
  /^foreword$/i,
  /^preface$/i,
  /^introduction$/i,
  /^epilogue$/i,
  /^afterword$/i,
  /^bibliography$/i,
  /^index$/i,
  /^glossary$/i,
  /^appendix(\s+\w+)?$/i,
  /^footnote(s)?$/i,
  /^endnote(s)?$/i,
  /^note(s)?$/i,
  /^praise\s+for/i,
  /^also\s+by/i,
  /^other\s+books/i,
  /^penguin\s+story$/i,
  /^publisher'?s?\s+note$/i,
  /^the\s+(full\s+)?project\s+gutenberg\s+license/i,
  /^project\s+gutenberg/i,
  /^end\s+of\s+(the\s+)?project\s+gutenberg/i,
  /^a\s+note\s+about\s+this\s+ebook/i,
  /^(books?\s+by|other\s+works\s+by)/i,
  /^colophon$/i,
  /^source\s+notes?$/i,
  /^works\s+cited$/i,
  /^further\s+reading$/i,
  /^(suggestions?\s+for\s+)?further\s+reading$/i,
  /^recommended\s+reading$/i,
  /^selected\s+bibliography$/i,
  /^discussion\s+questions?$/i,
  /^permissions?$/i,
  /^credits?$/i,
];

const BOOK_DIVIDER_PATTERNS = [
  { pattern: /^[A-Z\s]+$/, maxChars: 100 },
  { pattern: /^(book|part|volume)\s+\w+(?:\s*[:\-–—]\s*.+)?$/i, maxChars: 500 },
];

const FRONT_MATTER_TYPES = new Set(['cover', 'copyright', 'toc', 'frontmatter', 'backmatter', 'author', 'divider']);

function isChapterOneTitle(title = '') {
  const normalized = normalizeChapterTitleForDisplay(title)
    .trim()
    .replace(/\s+/g, ' ');

  if (!normalized) return false;

  return (
    /^chapter\s+(?:1|one|i)\b/i.test(normalized) ||
    /^chapter\s+the\s+first\b/i.test(normalized) ||
    /^ch\.?\s*(?:1|one|i)\b/i.test(normalized) ||
    /^(?:1|one|i)(?:[\s.:\-–—]|$)/i.test(normalized)
  );
}

function isChapterLikeTitle(title = '') {
  const normalized = normalizeChapterTitleForDisplay(title)
    .trim()
    .replace(/\s+/g, ' ');

  if (!normalized) return false;

  return (
    /^chapter\s+(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|the\s+first)\b/i.test(normalized) ||
    /^ch\.?\s*(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i.test(normalized) ||
    /^(?:\d+|[ivxlcdm]+)(?:[\s.:\-–—]|$)/i.test(normalized)
  );
}

function isExplicitFrontMatterTitle(title = '') {
  return /^(cover|title page|copyright|publisher|isbn|table of contents|contents|preface|foreword|introduction|prologue|about the author|author'?s? note|about the authors?|dedication|acknowledgments?)\b/i
    .test(String(title || '').trim());
}

function isPrologueTitle(title = '') {
  return /^prologue\b/i.test(String(title || '').trim());
}

function titleComparisonKey(value = '') {
  return stripHTML(String(value))
    .normalize('NFKC')
    .toLocaleLowerCase('en')
    .replace(/[\p{P}\p{S}\s]+/gu, '');
}

function isAttributionOrProseLine(value = '') {
  const line = String(value || '').replace(/\s+/g, ' ').trim();
  if (!line) return false;
  const words = line.split(/\s+/).length;
  const explicitByline = /^(?:by|written\s+by|edited\s+by|translated\s+by)\b/iu.test(line);
  const jointByline = /^(?:[\p{Lu}](?:\.|[\p{L}'’\-]+)(?:\s+[\p{Lu}](?:\.|[\p{L}'’\-]+)){0,3}),\s+(?:with|and)\s+(?:[\p{Lu}](?:\.|[\p{L}'’\-]+)(?:\s+[\p{Lu}](?:\.|[\p{L}'’\-]+)){0,3})\s*:/u.test(line);
  const recipientByline = /^[\p{Lu}][\p{L}'’\-]{2,30}\s*:\s+(?:to|for)\s+(?:the|an?)\b/u.test(line);
  const sentenceLike = words >= 10 && /[.!?;]$/.test(line);
  const clauseLike = words >= 14 && (line.match(/,/g) || []).length >= 2;
  return explicitByline || jointByline || recipientByline || sentenceLike || clauseLike || line.length > 160;
}

function deriveHeadingTitleFromText(text = '') {
  const lines = String(text || '')
    .split(/\n+/)
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 4);

  if (lines.length === 0) return '';

  const [first, second] = lines;

  if (/^\d{1,3}$/.test(first) && second && second.length <= 80) {
    return `${first} ${second}`;
  }

  const romanHeading = first.match(/^([IVXLCDM]+)(?:\s+\d{1,4})?$/i);
  if (
    romanHeading &&
    second &&
    second.length <= 180 &&
    !isAttributionOrProseLine(second)
  ) {
    return `${romanHeading[1].toUpperCase()}: ${second}`;
  }

  if (/^prologue$/i.test(first) && second && second.length <= 80) {
    return `PROLOGUE: ${second}`;
  }

  const firstWordCount = first.split(/\s+/).length;
  if (
    isExplicitFrontMatterTitle(first) ||
    /^[A-Z][A-Za-z\s:.'’\-–—]{2,80}$/.test(first) ||
    (first.length <= 80 && firstWordCount <= 8 && !/[.!?;]$/.test(first))
  ) {
    return first;
  }

  return '';
}

const TITLE_PAGE_MAX_CHARS = 700;

function restatesWorkIdentity(lines = [], work = null) {
  const workTitle = titleComparisonKey(work?.title || '');
  const workAuthor = titleComparisonKey(work?.author || '');
  if (!workTitle || !workAuthor || workTitle.length < 4 || workAuthor.length < 4) return false;
  const [firstLine] = lines;
  if (titleComparisonKey(firstLine || '') !== workTitle) return false;
  return lines.slice(1).some(line => titleComparisonKey(line).includes(workAuthor));
}

function structuralChapterMetadata(chapter = {}, derivedTitle = '', work = null) {
  const text = String(chapter.text || '').trim();
  const title = String(chapter.title || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;

  const prefix = text.slice(0, 2400);
  const lines = prefix
    .split(/\n+/)
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 12);
  const firstLine = lines[0] || '';

  if (
    /(?:\bcopyright\b|©\s*\d{4})/i.test(prefix) &&
    /(?:all rights reserved|\bISBN\b|published\s+\d{4})/i.test(prefix)
  ) {
    return { title: 'Copyright', type: 'copyright' };
  }

  if (/^dedicat(?:ed|ion)\b/i.test(firstLine) && text.length < 2500) {
    return { title: 'Dedication', type: 'frontmatter' };
  }

  const numberedContentsLines = lines.filter(line => /^\d{1,3}[.)]\s+\S/.test(line)).length;
  const hasLongProseLine = lines.some(line => line.length > 180);
  const trustedTocTitle = chapter.fromToc === true || chapter.tocTitleSource === 'href';
  const hasEarlyContentsHeading = lines.slice(0, 4)
    .some(line => /^(?:table\s+of\s+)?contents\b/i.test(line));
  if (
    hasEarlyContentsHeading ||
    (!trustedTocTitle && numberedContentsLines >= 3 && !hasLongProseLine)
  ) {
    return { title: 'Contents', type: 'toc' };
  }

  if (
    text.length < TITLE_PAGE_MAX_CHARS &&
    /\b(?:publishers?|press)\b/i.test(prefix) &&
    /\b(?:by|author|presented|proclaimed)\b/i.test(prefix)
  ) {
    return { title: 'Title Page', type: 'cover' };
  }

  // An imprint line is the weaker signal, and plenty of title pages carry none
  // — this one names the book, names the author, and stops. The strongest
  // evidence a section is the title page is that it restates the work's own
  // identity, which the classifier can only use once it is told what that is.
  // Requiring both the title and the author keeps a short piece that merely
  // shares the book's name, as a title poem does, from being mistaken for it.
  if (
    text.length < TITLE_PAGE_MAX_CHARS &&
    restatesWorkIdentity(lines, work)
  ) {
    return { title: 'Title Page', type: 'cover' };
  }

  const sectionTitle = derivedTitle || title;
  for (const divider of BOOK_DIVIDER_PATTERNS) {
    if (divider.pattern.test(sectionTitle) && text.length <= divider.maxChars) {
      return { title: sectionTitle, type: 'divider' };
    }
  }

  if (/^praise\s+for\b/i.test(firstLine || sectionTitle)) {
    return { title: normalizeAllCapsTitle(firstLine || sectionTitle), type: 'backmatter' };
  }

  const genericTitle = isChapterLikeTitle(title) || /^section\s+\d+$/i.test(title);
  if (
    genericTitle &&
    !isChapterLikeTitle(firstLine) &&
    /\b(?:prolific author|direct disciple|was born|is the author of|has written|founded)\b/i.test(prefix)
  ) {
    const person = lines.find(line =>
      /^(?:(?:Dr\.|Sri|Swami|Paramhansa|Paramahansa)\s+)?[A-Z][\p{L}'’.-]+(?:\s+[A-Z][\p{L}'’.-]+){1,4}$/u.test(line) &&
      !/^(?:Chapter|Praise|Copyright|Contents|Introduction|Foreword)\b/i.test(line)
    );
    if (person) return { title: `About ${person}`, type: 'author' };
  }

  const biographySignals = [
    /\bis the author of\b/i,
    /\bhas written\b/i,
    /\bwas born\b/i,
    /\bgraduated from\b/i,
    /\blives in\b/i,
    /\b(?:won|received)\s+(?:the\s+)?[A-Z]/
  ].filter(pattern => pattern.test(prefix)).length;
  if (chapter.titleSource === 'text' && biographySignals >= 2) {
    return { title: 'About the Author', type: 'author' };
  }

  if (
    /^(?:further\s+(?:explorations?|reading)|about\s+(?:the\s+)?authors?)\b/i.test(sectionTitle) ||
    (/\b(?:publishers?|publishing|press)\b/i.test(sectionTitle) &&
      /\b(?:books?|music|offer|resources?|spiritual|readers?)\b/i.test(prefix)) ||
    (/\bcontact information\b/i.test(prefix) && /\b(?:online|email|phone|mail):/i.test(prefix))
  ) {
    return { title: sectionTitle || firstLine || 'Back Matter', type: 'backmatter' };
  }

  return null;
}

function normalizeChapterMetadata(chapter = {}, work = null) {
  if (!chapter || typeof chapter !== 'object') return chapter;
  if (
    chapter.title === 'Contents' &&
    chapter.rawTitle &&
    !/^(?:table\s+of\s+)?contents$/i.test(String(chapter.rawTitle).trim())
  ) {
    const { rawTitle, rawType, ...stored } = chapter;
    chapter = {
      ...stored,
      title: rawTitle,
      type: rawType || 'content'
    };
  }
  const displayTitle = isChapterLikeTitle(chapter.title)
    ? chapter.title
    : repairTextArtifacts(chapter.title).replace(/\s+/g, ' ').trim();
  if (displayTitle && displayTitle !== chapter.title) {
    chapter = {
      ...chapter,
      rawTitle: chapter.rawTitle || chapter.title,
      title: displayTitle
    };
  }
  const derivedTitle = deriveHeadingTitleFromText(chapter.text || '');
  const currentTitle = String(chapter.title || '').trim();
  const currentIsChapter = isChapterLikeTitle(currentTitle);
  const trustedTocTitle = chapter.fromToc === true ||
    chapter.tocTitleSource === 'href' ||
    chapter.titleSource === 'heading' ||
    chapter.titleSource === 'spine';
  const trustedDocumentHeading = chapter.titleSource === 'heading' || chapter.titleSource === 'spine';
  const openingLine = String(chapter.text || '').split(/\n+/)[0] || '';
  const currentTitleKey = titleComparisonKey(currentTitle);
  const openingLineKey = titleComparisonKey(openingLine);
  if (trustedDocumentHeading) {
    return currentIsChapter && chapter.type === 'content'
      ? { ...chapter, type: 'chapter' }
      : chapter;
  }

  const structural = structuralChapterMetadata(chapter, derivedTitle, work);
  if (structural) {
    const next = {
      ...chapter,
      title: structural.title,
      type: structural.type
    };
    if (currentTitle && currentTitle !== structural.title) next.rawTitle = chapter.rawTitle || chapter.title;
    if (chapter.type && chapter.type !== structural.type) next.rawType = chapter.rawType || chapter.type;
    return next;
  }
  if (trustedTocTitle && currentTitleKey && openingLineKey.startsWith(currentTitleKey)) {
    return currentIsChapter && chapter.type === 'content'
      ? { ...chapter, type: 'chapter' }
      : chapter;
  }
  if (!derivedTitle && currentIsChapter && chapter.type === 'frontmatter') {
    return {
      ...chapter,
      rawTitle: chapter.rawTitle || chapter.title,
      title: 'Front Matter'
    };
  }

  if (!derivedTitle) return chapter;

  const derivedIsChapter = isChapterLikeTitle(derivedTitle);
  if (currentIsChapter && trustedTocTitle) {
    // A trusted TOC title keeps its numbering, but it must not overrule a
    // content-based structural classification such as frontmatter: shifted
    // TOCs routinely attach chapter-numbered labels to prefatory sections.
    if (chapter.type === 'content') return { ...chapter, type: 'chapter' };
    return chapter;
  }
  const currentLooksShifted = currentIsChapter && currentTitle !== derivedTitle;

  if (!currentLooksShifted) return chapter;

  const next = {
    ...chapter,
    rawTitle: chapter.rawTitle || chapter.title,
    title: derivedTitle
  };

  if (derivedIsChapter) {
    if (chapter.type && chapter.type !== 'chapter') {
      next.rawType = chapter.rawType || chapter.type;
    }
    next.type = 'chapter';
  } else if (isPrologueTitle(derivedTitle) && String(chapter.text || '').trim().length > 500) {
    next.type = 'content';
  } else if (isExplicitFrontMatterTitle(derivedTitle) || chapter.type === 'frontmatter') {
    next.type = 'frontmatter';
  }

  return next;
}

function normalizeChapterType(chapter = {}, work = null) {
  return normalizeChapterMetadata(chapter, work);
}

function normalizeChapterTitleForDisplay(title = '') {
  const cleaned = repairTextArtifacts(title)
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/\s+([:;?!])/g, '$1')
    .trim();

  if (!cleaned) return '';

  const chapterMatch = cleaned.match(
    /^(chapter\s+(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|the\s+first)\b|ch\.?\s*(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\b)/i
  );
  if (chapterMatch) {
    const prefix = normalizeAllCapsTitle(chapterMatch[1].replace(/\s+/g, ' ').trim());
    const suffix = cleaned.slice(chapterMatch[0].length).trim().replace(/^[:.\-–—]\s*/, '');
    const subtitle = extractTitleLikeSubtitle(suffix);
    return subtitle ? `${prefix} ${normalizeAllCapsTitle(subtitle)}` : prefix;
  }

  const numberedMatch = cleaned.match(/^((?:\d+|[ivxlcdm]+)[.:\-–—]?)(?:\s+|$)/i);
  if (numberedMatch) {
    const suffix = cleaned.slice(numberedMatch[0].length).trim();
    if (/[.!?]\s+[A-Z"']/.test(suffix)) {
      const subtitle = extractTitleLikeSubtitle(suffix);
      return subtitle ? `${numberedMatch[1].trim()} ${normalizeAllCapsTitle(subtitle)}` : numberedMatch[1].trim();
    }
  }

  const sentenceBreak = cleaned.match(/^(.{12,80}?[.!?])\s+[A-Z"']/);
  if (sentenceBreak && !/\b(?:Mr|Mrs|Ms|Dr|Prof|St|vs|etc|Jr|Sr)\.$/i.test(sentenceBreak[1])) {
    return sentenceBreak[1].trim();
  }

  if (cleaned.length <= 80) return cleaned;

  return `${cleaned.slice(0, 77).trim()}...`;
}

function extractTitleLikeSubtitle(text = '') {
  const cleaned = String(text || '').trim();
  if (!cleaned) return '';

  const sentenceEnd = findTitleSentenceEnd(cleaned);
  const candidate = (sentenceEnd === -1 ? cleaned : cleaned.slice(0, sentenceEnd)).trim();
  if (!candidate || candidate.length > 60) return '';

  const words = candidate.split(/\s+/);
  if (words.length > 8) return '';
  if (/^(it|this|that|there|he|she|they|we|i|you)\b/i.test(candidate)) return '';
  if (/\b(was|were|is|are|am|had|has|have|said|says|went|came|looked|thought)\b/i.test(candidate) && words.length > 3) return '';

  if (/(?:\b[A-Z]\.){1,}$/.test(candidate)) return candidate;
  return candidate.replace(/[:.\-–—]+$/, '').trim();
}

function findTitleSentenceEnd(text, maxLength = 80) {
  const boundary = /[.!?](?=\s+[A-Z"']|$)/g;
  let match;
  while ((match = boundary.exec(text)) !== null) {
    if (match.index > maxLength) return -1;
    if (match[0] === '.') {
      const prefix = text.slice(0, match.index + 1);
      if (
        /\b(?:Mr|Mrs|Ms|Dr|Prof|St|vs|v|etc|Jr|Sr|No|Nos|Vol|Dept|Inc|Ltd|Co)\.$/i.test(prefix) ||
        /\b[A-Z]\.$/.test(prefix)
      ) {
        continue;
      }
    }
    return match.index;
  }
  return -1;
}

function findPreferredAudioStartChapterIndex(chapters) {
  if (!Array.isArray(chapters) || chapters.length === 0) return -1;

  let firstNamedChapter = -1;
  let firstContent = -1;
  let firstSubstantial = -1;
  let firstSubstantialPrologue = -1;

  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i] || {};
    const title = chapter.title || '';
    const textLength = (chapter.text || '').trim().length;

    if (isChapterOneTitle(title)) {
      if (firstSubstantialPrologue !== -1) return firstSubstantialPrologue;
      return i;
    }

    if (
      firstSubstantialPrologue === -1 &&
      isPrologueTitle(title) &&
      !FRONT_MATTER_TYPES.has(chapter.type) &&
      textLength > 500
    ) {
      firstSubstantialPrologue = i;
    }

    if (firstNamedChapter === -1 && chapter.type === 'chapter') {
      firstNamedChapter = i;
    }

    if (firstContent === -1 && chapter.type === 'content' && textLength > 500) {
      firstContent = i;
    }

    if (firstSubstantial === -1 && !FRONT_MATTER_TYPES.has(chapter.type) && textLength > 500) {
      firstSubstantial = i;
    }
  }

  if (firstContent !== -1) return firstContent;
  if (firstNamedChapter !== -1) return firstNamedChapter;
  if (firstSubstantial !== -1) return firstSubstantial;
  return Math.min(2, chapters.length - 1);
}

function shouldFilterChapter(chapter) {
  const { title, text } = chapter;
  const charCount = text.trim().length;

  if (charCount < 300) {
    if (/^Chapter \d+$/i.test(title.trim())) {
      return false;
    }
    return true;
  }

  const trimmedTitle = title.trim();
  const isGutenberg = /project\s+gutenberg/i.test(trimmedTitle);
  for (const pattern of FILLER_TITLE_PATTERNS) {
    if (pattern.test(trimmedTitle)) {
      if (charCount > 5000 && !isGutenberg) {
        continue;
      }
      return true;
    }
  }

  for (const divider of BOOK_DIVIDER_PATTERNS) {
    if (divider.pattern.test(title) && charCount <= divider.maxChars) {
      return true;
    }
  }

  const contentLower = text.substring(0, 500).toLowerCase();
  const bioPatterns = [
    /was born in/i,
    /is the author of/i,
    /has written/i,
    /lives in/i,
    /graduated from/i,
    /\u00a9 \d{4}/i,
    /all rights reserved/i,
    /isbn/i,
    /published by/i,
  ];

  let patternMatches = 0;
  for (const pattern of bioPatterns) {
    if (pattern.test(contentLower)) {
      patternMatches++;
    }
  }
  return patternMatches >= 2 && charCount < 2000;
}

module.exports = {
  FILLER_TITLE_PATTERNS,
  BOOK_DIVIDER_PATTERNS,
  FRONT_MATTER_TYPES,
  isChapterOneTitle,
  isChapterLikeTitle,
  isExplicitFrontMatterTitle,
  isPrologueTitle,
  isAttributionOrProseLine,
  titleComparisonKey,
  normalizeChapterMetadata,
  normalizeChapterType,
  normalizeChapterTitleForDisplay,
  findPreferredAudioStartChapterIndex,
  shouldFilterChapter
};
