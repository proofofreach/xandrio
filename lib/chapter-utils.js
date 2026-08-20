const {
  SUBSTANTIAL_SECTION_CHARS,
  assessReadableContentLength
} = require('./content-length-policy');
const {
  ALLOWED_TEXT_MUTATIONS,
  mutationActivation
} = require('./extraction-result');

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
const ROMAN_NUMERAL_RE = /^(?:M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3}))$/;
const PRESERVE_WORDS = new Set(['US', 'UK', 'FBI', 'CIA', 'NASA', 'DNA', 'PhD', 'CEO', 'USA', 'USSR', 'NYC', 'LA', 'DC', 'AI', 'TV', 'BBC', 'MIT', 'MBA', 'UN', 'EU', 'WHO', 'NATO']);
const { splitOversizedText } = require('./tts-text');

const OVERSIZED_CHAPTER_THRESHOLD = 100000;
const REPAIRED_CHAPTER_TARGET = 90000;
// A section this large is not a usable audiobook chapter under any authoring
// intent, so import rejects the edition outright. Repair must therefore always
// run below this line: any chapter left above it is guaranteed to fail import.
const UNUSABLE_CHAPTER_THRESHOLD = 150000;

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

function structuralChapterMetadata(chapter = {}, derivedTitle = '') {
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
    text.length < 700 &&
    /\b(?:publishers?|press)\b/i.test(prefix) &&
    /\b(?:by|author|presented|proclaimed)\b/i.test(prefix)
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

function normalizeChapterMetadata(chapter = {}) {
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

  const structural = structuralChapterMetadata(chapter, derivedTitle);
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

function normalizeChapterType(chapter = {}) {
  return normalizeChapterMetadata(chapter);
}

function romanNumeralToNumber(value = '') {
  const roman = String(value).toUpperCase();
  if (!roman || !ROMAN_NUMERAL_RE.test(roman)) return null;
  const values = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let total = 0;
  for (let index = 0; index < roman.length; index++) {
    const current = values[roman[index]];
    const next = values[roman[index + 1]] || 0;
    total += current < next ? -current : current;
  }
  return total > 0 ? total : null;
}

function sequentialHeadingCandidate(chapter = {}) {
  const lines = String(chapter.text || '')
    .split(/\n+/)
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 4);
  const markerIndex = lines.findIndex((line, index) =>
    index <= 2 && /^([IVXLCDM]+)(?:\s+\d{1,4})?$/i.test(line)
  );
  if (markerIndex < 0) return null;
  const marker = lines[markerIndex].match(/^([IVXLCDM]+)(?:\s+\d{1,4})?$/i);
  if (!marker) return null;
  const number = romanNumeralToNumber(marker[1]);
  if (!number) return null;
  const subtitle = lines[markerIndex + 1] || '';
  const title = (
    subtitle &&
    subtitle.length <= 180 &&
    !isAttributionOrProseLine(subtitle)
  )
    ? `${marker[1].toUpperCase()}: ${subtitle}`
    : marker[1].toUpperCase();
  return {
    number,
    title
  };
}

function repairSequentialChapterSeries(chapters = []) {
  const candidates = chapters.map(sequentialHeadingCandidate);
  const repaired = chapters.slice();
  let runStart = 0;

  while (runStart < candidates.length) {
    if (!candidates[runStart]) {
      runStart++;
      continue;
    }

    let runEnd = runStart + 1;
    while (
      runEnd < candidates.length &&
      candidates[runEnd] &&
      candidates[runEnd].number === candidates[runEnd - 1].number + 1
    ) {
      runEnd++;
    }

    if (runEnd - runStart >= 5) {
      for (let index = runStart; index < runEnd; index++) {
        const chapter = chapters[index];
        const candidate = candidates[index];
        const titleChanged = chapter.title !== candidate.title && chapter.fromToc !== true;
        const typeChanged = chapter.type !== 'chapter';
        if (!titleChanged && !typeChanged) continue;

        repaired[index] = {
          ...chapter,
          ...(titleChanged
            ? { rawTitle: chapter.rawTitle || chapter.title, title: candidate.title }
            : {}),
          ...(typeChanged
            ? { rawType: chapter.rawType || chapter.type, type: 'chapter' }
            : {})
        };
      }
    }

    runStart = runEnd;
  }

  return repaired;
}

// ── Degenerate section merge (format-independent structure heuristic) ────────
//
// Evidence class: a section whose whole body is a heading rather than
// narration ("PART 1 / APPROACHING THE UNCONSCIOUS / Carl G. Jung",
// "FROM / <work> / (1954)"), or an un-authored sub-threshold fragment
// (a stray figure caption emitted as its own spine item). Either one is a
// three-second audio chapter that interrupts playback and, when it carries the
// real section name, leaves the following section stuck with a generic
// placeholder title.
//
// A version of this rule already lived inside the EPUB spine assembler, keyed
// on divider vocabulary ("part"/"book"/"volume") and skipping anything the TOC
// authored. That reached neither the Kindle nor the PDF assembler, and missed
// authored dividers on its own path. The rule belongs to the shared sequence
// normalizer instead, keyed on what the section *is* rather than what it is
// called: every format, and every re-read of a stored artifact, then gets the
// same bounded treatment.
//
// Bounds: text is conserved exactly — sections are joined with the same
// '\n\n' separator the narration hash uses, never dropped. The pass declines
// entirely when degenerate sections are not a clear minority, because a book
// built from short sections (poetry, aphorisms, devotionals) is authored that
// way and merging would destroy its real structure.
const DEGENERATE_SECTION_CHARS = SUBSTANTIAL_SECTION_CHARS;
const HEADING_LINE_MAX_CHARS = 80;
const HEADING_LINE_MAX_WORDS = 12;
const MERGED_HEADING_MAX_CHARS = 80;
const CHARS_PER_MINUTE = 825;

function sectionLines(text = '') {
  return String(text || '')
    .split(/\n+/)
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function isHeadingLikeLine(line = '') {
  if (!line || line.length > HEADING_LINE_MAX_CHARS) return false;
  if (line.split(/\s+/).length > HEADING_LINE_MAX_WORDS) return false;
  if (isAttributionOrProseLine(line)) return false;
  // A sentence-terminating period, or a trailing comma/semicolon continuing
  // into the next line, is prose evidence. A colon, a bang, or a question mark
  // belongs to plenty of real titles ("The Fool's Progress:", "Hayduke
  // Lives!"), so those stay heading-like under the length and word bounds.
  return !/[.,;]$/.test(line);
}

function hasAuthoredNavigation(chapter = {}) {
  return chapter.fromToc === true ||
    chapter.authoredBoundary === true ||
    chapter.authoredChapter === true ||
    chapter.tocTitleSource === 'href' ||
    Boolean(String(chapter.sourceHref || '').trim());
}

// 'heading'  — the body is nothing but its own heading lines.
// 'fragment' — sub-threshold text that nothing claims as a section: no
//   authored navigation entry, and no title beyond an ordinal placeholder.
//   That is stray spine debris such as a figure caption. A short section that
//   carries a real name is a short section, however brief its prose.
function degenerateSectionKind(chapter = {}, thresholdChars = DEGENERATE_SECTION_CHARS) {
  const text = String(chapter?.text || '').trim();
  if (!text || text.length > thresholdChars) return null;
  const lines = sectionLines(text);
  if (lines.length && lines.every(isHeadingLikeLine)) return 'heading';
  if (hasAuthoredNavigation(chapter)) return null;
  return isPlaceholderSectionTitle(chapter?.title) ? 'fragment' : null;
}

function sectionHeading(chapter = {}) {
  const lines = sectionLines(chapter?.text);
  if (!lines.length || !lines.every(isHeadingLikeLine)) return '';
  const heading = normalizeAllCapsTitle(lines.join(' ').replace(/\s+/g, ' ').trim());
  if (heading.length > MERGED_HEADING_MAX_CHARS) return '';
  return heading;
}

function isPlaceholderSectionTitle(title = '') {
  const normalized = String(title || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return true;
  return /^(?:chapter|section)\s+(?:\d+|[ivxlcdm]+)$/i.test(normalized) ||
    /^front\s+matter$/i.test(normalized);
}

function isAuxiliaryLabel(title = '') {
  const normalized = String(title || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  return isExplicitFrontMatterTitle(normalized) ||
    FILLER_TITLE_PATTERNS.some(pattern => pattern.test(normalized));
}

// A divider that names a work carries a label, the work's title, and often a
// date on separate lines. A single-line stub is a dedication, an address, or a
// marketing line — it names nobody's chapter, so it never becomes a title.
function promotableHeading(section = {}) {
  const lines = sectionLines(section?.text);
  if (lines.length < 2) return '';
  const heading = sectionHeading(section);
  return isPlaceholderSectionTitle(heading) ? '' : heading;
}

function absorbSections(host, sections, placement) {
  const hostText = String(host?.text || '');
  const sectionTexts = sections.map(section => String(section?.text || '')).filter(Boolean);
  const text = placement === 'before'
    ? [...sectionTexts, hostText].join('\n\n')
    : [hostText, ...sectionTexts].join('\n\n');
  const headings = sections.map(sectionHeading).filter(Boolean);
  const merged = {
    ...host,
    text,
    estimatedDuration: Math.round(text.length / CHARS_PER_MINUTE * 60),
    mergedSectionCount: (Number(host?.mergedSectionCount) || 0) + sections.length
  };
  if (headings.length) {
    merged.parentContext = [...(host?.parentContext || []), ...headings];
  }
  // Title repair, not narration change: a divider that carried the real
  // section name hands it to a host still labelled with a generic ordinal.
  // rawTitle keeps the original, so the structure key is unaffected.
  //
  // Auxiliary vocabulary ("Copyright", "Contents", "Also by ...") only names a
  // host that is itself a recognized non-narrative section. Promoting it onto
  // narrative text would relabel a story as front matter, which is worse than
  // the generic ordinal it replaced.
  const hostIsNarrative = !FRONT_MATTER_TYPES.has(host?.type);
  const promoted = placement === 'before'
    ? sections
      .map(promotableHeading)
      .find(heading => heading && !(hostIsNarrative && isAuxiliaryLabel(heading)))
    : '';
  if (promoted && isPlaceholderSectionTitle(host?.title)) {
    merged.rawTitle = host?.rawTitle || host?.title;
    merged.title = promoted;
  }
  return merged;
}

function mergeDegenerateSections(chapters = [], options = {}) {
  if (!Array.isArray(chapters)) return [];
  if (chapters.length < 2) return chapters;

  const thresholdChars = Number(options.thresholdChars) || DEGENERATE_SECTION_CHARS;
  const oversizedChars = Number(options.oversizedChars) || OVERSIZED_CHAPTER_THRESHOLD;
  const kinds = chapters.map(chapter => degenerateSectionKind(chapter, thresholdChars));
  const degenerateCount = kinds.filter(Boolean).length;
  if (degenerateCount === 0) return chapters;
  // Density guard: degenerate sections must be a clear minority for the
  // "this is a divider, not a chapter" reading to hold.
  if (degenerateCount * 2 >= chapters.length) return chapters;

  const merged = [];
  let pending = [];
  let pendingChars = 0;

  const flushPendingUnmerged = () => {
    for (const section of pending) merged.push(section);
    pending = [];
    pendingChars = 0;
  };

  for (let index = 0; index < chapters.length; index++) {
    const chapter = chapters[index];
    if (kinds[index]) {
      pending.push(chapter);
      pendingChars += String(chapter?.text || '').length + 2;
      continue;
    }
    if (!pending.length) {
      merged.push(chapter);
      continue;
    }
    // Never let a merge manufacture an unusable oversized chapter.
    if (String(chapter?.text || '').length + pendingChars > oversizedChars) {
      flushPendingUnmerged();
      merged.push(chapter);
      continue;
    }
    merged.push(absorbSections(chapter, pending, 'before'));
    pending = [];
    pendingChars = 0;
  }

  if (pending.length) {
    const host = merged[merged.length - 1];
    if (!host || String(host.text || '').length + pendingChars > oversizedChars) {
      flushPendingUnmerged();
    } else {
      merged[merged.length - 1] = absorbSections(host, pending, 'after');
    }
  }

  return merged.map((chapter, index) => ({ ...chapter, index }));
}

// Staged rollout, not a format heuristic. The merge rule above is
// format-independent and its evidence never mentions a container; what is
// staged is only which already-imported libraries get re-cut, because a re-cut
// resets saved reading positions and clears generated audio for every affected
// book. Kindle containers carry the defect worst, so they go first. Extending
// this set is a scope decision, not a change to the rule.
const DEGENERATE_MERGE_SOURCE_FORMATS = new Set(['mobi', 'azw', 'azw3', 'prc', 'kfx']);

function mergesDegenerateSections(sourceFormat = '') {
  return DEGENERATE_MERGE_SOURCE_FORMATS.has(String(sourceFormat || '').trim().toLowerCase());
}

function normalizeChapterSequence(chapters = [], options = {}) {
  if (!Array.isArray(chapters)) return [];
  const normalizedMetadata = chapters.map(normalizeChapterMetadata);
  // Merge before series repair: repair reads a chapter's own opening lines, so
  // it must see the sections a reader will actually hear.
  const mergedSections = mergesDegenerateSections(options.sourceFormat)
    ? mergeDegenerateSections(normalizedMetadata)
    : normalizedMetadata;
  const repairedSeries = repairSequentialChapterSeries(mergedSections);
  const normalized = repairedSeries.map((chapter, index) => ({
    ...chapter,
    index
  }));
  const firstChapterIndex = normalized.findIndex(chapter =>
    chapter?.type === 'chapter' || isChapterLikeTitle(chapter?.title)
  );
  return normalized.map((chapter, index) => {
    if (
      firstChapterIndex > 0 &&
      index < firstChapterIndex &&
      chapter?.type === 'content' &&
      /^(?:preface|foreword)(?:\b|$)/i.test(String(chapter.title || '').trim())
    ) {
      return { ...chapter, type: 'frontmatter' };
    }
    return chapter;
  });
}

// Some valid ebooks place most or all of the prose in one spine item. That is
// legal EPUB/Kindle structure, but it creates an unusable audiobook chapter and
// was previously treated as a corrupt import. Split only truly oversized
// sections, at punctuation/word boundaries, while retaining source metadata.
function splitOversizedChapters(chapters = [], options = {}) {
  if (!Array.isArray(chapters)) return [];
  const thresholdChars = Number(options.thresholdChars) || OVERSIZED_CHAPTER_THRESHOLD;
  // An authored boundary earns the chapter a reprieve from splitting, but only
  // up to the point where a single section is unplayable and import rejects the
  // whole edition. Books like Jung's Red Book carry one authored 160K+ section
  // among dozens of healthy ones; honouring the boundary there loses the book.
  const authoredThresholdChars = Math.max(
    thresholdChars,
    Number(options.authoredThresholdChars) || UNUSABLE_CHAPTER_THRESHOLD
  );
  const targetChars = Math.min(
    Number(options.targetChars) || REPAIRED_CHAPTER_TARGET,
    thresholdChars - 1
  );
  const repaired = [];

  for (const chapter of chapters) {
    const text = String(chapter?.text || '').trim();
    const hasAuthoredBoundary = Boolean(
      (chapter?.fromToc || chapter?.authoredBoundary) && String(chapter.title || '').trim()
    );
    const chapterThreshold = hasAuthoredBoundary ? authoredThresholdChars : thresholdChars;
    if (!chapter || text.length <= chapterThreshold) {
      repaired.push(chapter);
      continue;
    }

    const parts = splitOversizedText(text, targetChars);
    if (parts.length < 2 || parts.some(part => part.length > thresholdChars)) {
      repaired.push(chapter);
      continue;
    }

    const baseTitle = normalizeChapterTitleForDisplay(chapter.title) || `Chapter ${repaired.length + 1}`;
    parts.forEach((part, partIndex) => {
      const splitChapter = {
        ...chapter,
        title: `${baseTitle} — Part ${partIndex + 1} of ${parts.length}`,
        sourceTitle: chapter.sourceTitle || chapter.title,
        sourceChapterIndex: chapter.sourceChapterIndex ?? chapter.index,
        text: part,
        estimatedDuration: Math.round(part.length / 825 * 60),
        splitFromOversizedChapter: true,
        splitPart: partIndex + 1,
        splitPartCount: parts.length
      };
      // Extraction diagnostics only need to be retained once; duplicating the
      // full report on every generated part bloats persistent XBook artifacts.
      if (partIndex > 0) {
        delete splitChapter.kindleExtraction;
        delete splitChapter.pdfExtraction;
      }
      repaired.push(splitChapter);
    });
  }

  return repaired.map((chapter, index) => ({ ...chapter, index }));
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

/**
 * Text-level artifact repairs shared by HTML extraction and pre-extracted
 * chapter text (xbook imports from PDF etc., where stripHTML never runs).
 *
 * - "word- word": hyphenated compound split by a stray space (OCR /
 *   typesetting artifact, e.g. "leather- jacketed"). Rejoined unless the
 *   next word is a coordination, where the suspended hyphen's space is
 *   intentional ("copper- and iron-tipped").
 * - Soft hyphens / zero-width chars: split words for TTS engines.
 */
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

function buildChapterQuality(chapters, tocCount = 0, options = {}) {
  const narrativeChapters = chapters.filter(chapter => !FRONT_MATTER_TYPES.has(chapter?.type));
  const measuredChapters = narrativeChapters.length > 0 ? narrativeChapters : chapters;
  const contentChapters = measuredChapters.filter(ch => ch.text && ch.text.length > 500);
  const emptyChapters = chapters.filter(ch => !ch.text || ch.text.length <= 500);
  const maxChapterSize = Math.max(...measuredChapters.map(ch => ch.text ? ch.text.length : 0), 0);
  const totalChars = chapters.reduce((sum, chapter) => sum + String(chapter?.text || '').trim().length, 0);
  const replacementChars = chapters.reduce(
    (sum, chapter) => sum + (String(chapter?.text || '').match(/\uFFFD/g) || []).length,
    0
  );
  const hasGiantChapters = maxChapterSize > 100000;
  const tooFewContentChapters = contentChapters.length < 3;
  const spineTocMismatch = tocCount > chapters.length * 2;
  const nonLinearSpineIndexes = options.nonLinearSpineIndexes instanceof Set
    ? options.nonLinearSpineIndexes
    : new Set(options.nonLinearSpineIndexes || []);
  const leakedNonLinearIndexes = new Set(
    chapters
      .map(chapter => chapter?.originalIndex)
      .filter(index => nonLinearSpineIndexes.has(index))
  );
  const nonLinearLeakCount = leakedNonLinearIndexes.size;
  const isGoodStructure = !hasGiantChapters &&
    !spineTocMismatch &&
    !tooFewContentChapters &&
    nonLinearLeakCount === 0;

  return {
    isGoodStructure,
    structureVerified: nonLinearLeakCount === 0,
    totalChapters: chapters.length,
    narrativeChapters: measuredChapters.length,
    contentChapters: contentChapters.length,
    emptyChapters: emptyChapters.length,
    maxChapterSize,
    totalChars,
    replacementChars,
    tocEntries: tocCount,
    nonLinearLeakCount,
    reasons: [
      hasGiantChapters ? `Giant chapter: ${Math.floor(maxChapterSize / 1000)}K chars` : null,
      spineTocMismatch ? `TOC has ${tocCount} entries but only ${chapters.length} spine items` : null,
      tooFewContentChapters ? `Only ${contentChapters.length} content chapters` : null,
      nonLinearLeakCount > 0
        ? `${nonLinearLeakCount} non-linear spine ${nonLinearLeakCount === 1 ? 'document leaked' : 'documents leaked'} into sequential chapters`
        : null
    ].filter(Boolean)
  };
}

function validateExtractedChapters(chapters, options = {}) {
  const validationResult = {
    valid: false,
    errors: [],
    warnings: []
  };

  const format = options.format || 'book';
  const fileSize = options.fileSize || 0;
  const largeBookWarningSize = options.largeBookWarningSize || 50 * 1024 * 1024;
  if (fileSize > largeBookWarningSize) {
    validationResult.warnings.push(`Large ${format.toUpperCase()} file (${Math.round(fileSize / 1024 / 1024)}MB); extraction may be slower`);
  }

  if (!chapters || chapters.length === 0) {
    validationResult.errors.push('No readable content - book is empty or unsupported');
    return validationResult;
  }

  const totalChars = chapters.reduce((sum, chapter) => sum + (chapter.text || '').trim().length, 0);
  const substantialChapters = chapters.filter(
    chapter => (chapter.text || '').trim().length >= SUBSTANTIAL_SECTION_CHARS
  ).length;
  const lengthAssessment = assessReadableContentLength({
    totalChars,
    substantialSections: substantialChapters
  });
  if (!lengthAssessment.valid) {
    validationResult.errors.push(lengthAssessment.error);
    return validationResult;
  }
  if (lengthAssessment.warning) validationResult.warnings.push(lengthAssessment.warning);

  if (substantialChapters / chapters.length < 0.5) {
    validationResult.warnings.push(`${Math.floor((1 - substantialChapters / chapters.length) * 100)}% of sections are empty or very short`);
  }

  const repairedSections = new Set(
    chapters
      .filter(chapter => chapter?.splitFromOversizedChapter)
      .map(chapter => chapter.sourceChapterIndex ?? chapter.sourceTitle ?? chapter.title)
  ).size;
  if (repairedSections > 0) {
    validationResult.warnings.push(
      `Split ${repairedSections} oversized source ${repairedSections === 1 ? 'section' : 'sections'} into audiobook-sized chapters`
    );
  }

  validationResult.valid = true;
  return validationResult;
}

module.exports = {
  FILLER_TITLE_PATTERNS,
  BOOK_DIVIDER_PATTERNS,
  FRONT_MATTER_TYPES,
  OVERSIZED_CHAPTER_THRESHOLD,
  UNUSABLE_CHAPTER_THRESHOLD,
  isChapterOneTitle,
  isChapterLikeTitle,
  normalizeChapterMetadata,
  normalizeChapterType,
  normalizeChapterSequence,
  mergeDegenerateSections,
  mergesDegenerateSections,
  DEGENERATE_MERGE_SOURCE_FORMATS,
  DEGENERATE_SECTION_CHARS,
  repairSequentialChapterSeries,
  splitOversizedChapters,
  normalizeChapterTitleForDisplay,
  normalizeAllCapsTitle,
  findPreferredAudioStartChapterIndex,
  shouldFilterChapter,
  stripHTML,
  repairTextArtifacts,
  buildChapterQuality,
  validateExtractedChapters
};
