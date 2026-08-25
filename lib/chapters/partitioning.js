const { splitOversizedText } = require('../tts-text');
const { SUBSTANTIAL_SECTION_CHARS } = require('../content-length-policy');
const {
  FRONT_MATTER_TYPES,
  FILLER_TITLE_PATTERNS,
  isChapterLikeTitle,
  isExplicitFrontMatterTitle,
  isAttributionOrProseLine,
  titleComparisonKey,
  normalizeChapterMetadata,
  normalizeChapterTitleForDisplay
} = require('./classification');
const { normalizeAllCapsTitle } = require('./text-sanitization');

const ROMAN_NUMERAL_RE = /^(?:M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3}))$/;
const PRESERVE_WORDS = new Set(['US', 'UK', 'FBI', 'CIA', 'NASA', 'DNA', 'PhD', 'CEO', 'USA', 'USSR', 'NYC', 'LA', 'DC', 'AI', 'TV', 'BBC', 'MIT', 'MBA', 'UN', 'EU', 'WHO', 'NATO']);
const OVERSIZED_CHAPTER_THRESHOLD = 100000;
const REPAIRED_CHAPTER_TARGET = 90000;
const UNUSABLE_CHAPTER_THRESHOLD = 150000;

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
  // A recognized auxiliary section is not debris. A table of contents, a
  // copyright page, and a title page are all built from short unpunctuated
  // lines, so shape alone reads them as headings — but they are authored
  // sections that playback already skips by type. Absorbing one turns
  // skippable front matter into narration the listener cannot get past, which
  // is the very defect this pass exists to remove. Only a divider merges.
  if (FRONT_MATTER_TYPES.has(chapter?.type) && chapter.type !== 'divider') return null;
  const lines = sectionLines(text);
  if (lines.length && lines.every(isHeadingLikeLine)) return 'heading';
  if (hasAuthoredNavigation(chapter)) return null;
  return isPlaceholderSectionTitle(chapter?.title) ? 'fragment' : null;
}

// Print typography shouts a divider's label — "FROM", "PART" — while the rest
// of the line is mixed case. normalizeAllCapsTitle only rescues a title that is
// almost entirely capitals, so a heading joined out of such lines keeps a
// shouting word in the middle of ordinary prose case. Settle each word on its
// own, leaving acronyms and Roman numerals alone.
function normalizeSynthesizedHeadingCase(heading = '') {
  return String(heading).replace(/\S+/g, (word) => {
    const stripped = word.replace(/[^A-Za-z]/g, '');
    if (stripped.length < 2) return word;
    if (ROMAN_NUMERAL_RE.test(stripped)) return word;
    if (PRESERVE_WORDS.has(stripped)) return word;
    if (stripped !== stripped.toUpperCase()) return word;
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  });
}

function sectionHeading(chapter = {}) {
  const lines = sectionLines(chapter?.text);
  if (!lines.length || !lines.every(isHeadingLikeLine)) return '';
  const heading = normalizeSynthesizedHeadingCase(
    normalizeAllCapsTitle(lines.join(' ').replace(/\s+/g, ' ').trim())
  );
  if (heading.length > MERGED_HEADING_MAX_CHARS) return '';
  return heading;
}

// A divider does not always stand alone. An editor's note attached to one keeps
// the section above the merge bound and leaves it holding real prose, so the
// excerpt it introduces is left wearing whatever ordinal the source gave it.
// The name is still right there in the divider's opening lines, so hand it over
// without moving a character of narration.
function leadingDividerHeading(chapter = {}, thresholdChars = DEGENERATE_SECTION_CHARS) {
  const text = String(chapter?.text || '').trim();
  // A whole essay opens with heading-like lines too. Only a section short
  // enough to be a divider carrying a note can be read as introducing another.
  if (!text || text.length > thresholdChars * 2) return '';
  if (FRONT_MATTER_TYPES.has(chapter?.type) && chapter.type !== 'divider') return '';
  const lines = sectionLines(text);
  const heading = [];
  for (const line of lines) {
    if (!isHeadingLikeLine(line)) break;
    heading.push(line);
  }
  // Fewer than two lines is a section's own title, not a divider. All of them
  // is a bare divider, which the merge already handles.
  if (heading.length < 2 || heading.length === lines.length) return '';
  const label = normalizeSynthesizedHeadingCase(
    normalizeAllCapsTitle(heading.join(' ').replace(/\s+/g, ' ').trim())
  );
  if (!label || label.length > MERGED_HEADING_MAX_CHARS) return '';
  return isPlaceholderSectionTitle(label) || isAuxiliaryLabel(label) ? '' : label;
}

// Auxiliary sections must never be absorbed into narration — that is what turns
// skippable front matter into an unskippable preamble. Joining one to its own
// kind is a different act: a half-title and a title page are both the title
// page, playback skips the result exactly as it skipped the parts, and the
// chapter list stops showing the same name twice.
function coalesceAdjacentAuxiliary(chapters = [], options = {}) {
  if (!Array.isArray(chapters) || chapters.length < 2) return chapters;
  const thresholdChars = Number(options.thresholdChars) || DEGENERATE_SECTION_CHARS;
  const coalesced = [];

  for (const chapter of chapters) {
    const previous = coalesced[coalesced.length - 1];
    const type = chapter?.type;
    const joinable = previous &&
      FRONT_MATTER_TYPES.has(type) &&
      type !== 'divider' &&
      previous.type === type &&
      String(previous.text || '').trim().length <= thresholdChars;
    if (!joinable) {
      coalesced.push(chapter);
      continue;
    }
    const text = [String(previous.text || ''), String(chapter.text || '')].join('\n\n');
    coalesced[coalesced.length - 1] = {
      ...previous,
      text,
      estimatedDuration: Math.round(text.length / CHARS_PER_MINUTE * 60),
      mergedSectionCount: (Number(previous.mergedSectionCount) || 0) + 1
    };
  }

  return coalesced.map((chapter, index) => ({ ...chapter, index }));
}

// The same divider-with-note evidence, used to rejoin rather than to rename.
// A divider that introduces a single work, an editor's note about it, and the
// excerpt itself are one entry in the book's own contents; the source split
// them across two sections and named the second with a bare ordinal. Joining
// them restores the piece the book actually lists. Text is conserved, joined
// with the separator the narration hash uses.
function mergeDividerNotesIntoExcerpt(chapters = [], options = {}) {
  if (!Array.isArray(chapters) || chapters.length < 2) return chapters;
  const thresholdChars = Number(options.thresholdChars) || DEGENERATE_SECTION_CHARS;
  const oversizedChars = Number(options.oversizedChars) || OVERSIZED_CHAPTER_THRESHOLD;
  const merged = [];

  for (let index = 0; index < chapters.length; index++) {
    const donor = chapters[index];
    const recipient = chapters[index + 1];
    const label = recipient ? leadingDividerHeading(donor, thresholdChars) : '';
    if (!label || !isPlaceholderSectionTitle(recipient?.title)) {
      merged.push(donor);
      continue;
    }
    // Rejoining must never manufacture an unusable chapter. When it would, the
    // two stay apart — but the name still belongs to the excerpt, so hand it
    // over on its own. Display metadata only; rawTitle keeps the original.
    if (String(donor.text || '').length + String(recipient.text || '').length + 2 > oversizedChars) {
      merged.push(donor);
      chapters[index + 1] = retypeNamedSection({
        ...recipient,
        rawTitle: recipient.rawTitle || recipient.title,
        title: label
      }, label);
      continue;
    }
    const text = [String(donor.text || ''), String(recipient.text || '')].join('\n\n');
    merged.push(retypeNamedSection({
      ...recipient,
      text,
      title: label,
      rawTitle: recipient.rawTitle || recipient.title,
      estimatedDuration: Math.round(text.length / CHARS_PER_MINUTE * 60),
      mergedSectionCount: (Number(recipient.mergedSectionCount) || 0) + 1,
      parentContext: [...(recipient.parentContext || []), label]
    }, label));
    index += 1;
  }

  return merged.map((chapter, position) => ({ ...chapter, index: position }));
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

// Once a divider hands over its name, the ordinal the source used was never the
// book's own label for the piece — the book calls it by name. A section named
// "From Jonathan Troy (1954)" is the same kind of thing as one named "Cowboys",
// so it should not be the only sort that carries a number. rawType keeps the
// original, so the chapter structure key does not move.
function retypeNamedSection(chapter, promotedTitle) {
  if (!chapter || isChapterLikeTitle(promotedTitle) || chapter.type !== 'chapter') return chapter;
  return { ...chapter, rawType: chapter.rawType || chapter.type, type: 'content' };
}

// A title page absorbing "<Book Title> <Author>" is not a group heading; it is
// the same name twice.
function restatesTitle(heading, title) {
  const headingKey = titleComparisonKey(heading);
  const titleKey = titleComparisonKey(title);
  if (!headingKey || !titleKey) return false;
  return headingKey.startsWith(titleKey) || titleKey.startsWith(headingKey);
}

// A divider before a single unnamed piece is that piece's name. A divider
// before a contiguous run of numbered chapters is a heading over all of them,
// and those chapters keep the numbers the book gave them. The difference is
// visible in the shape alone: in a collection a divider stands before every
// excerpt, so a numbered section's immediate neighbours are dividers; under a
// part heading the numbered chapters sit next to each other.
function numberedRunMembership(chapters = []) {
  const numbered = chapters.map(chapter => isChapterLikeTitle(chapter?.title));
  return numbered.map((isNumbered, index) =>
    isNumbered && Boolean(numbered[index - 1] || numbered[index + 1]));
}

function absorbSections(host, sections, placement, allowPromotion = true) {
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
  if (promoted && allowPromotion && isPlaceholderSectionTitle(host?.title)) {
    merged.rawTitle = host?.rawTitle || host?.title;
    merged.title = promoted;
    return retypeNamedSection(merged, promoted);
  }
  // The divider named a work but this section already had its own name, so the
  // divider is what the printed contents shows as a heading over a run of
  // pieces rather than the name of any one of them. Record it as such, unless
  // it merely restates the name this section already carries.
  if (promoted && hostIsNarrative && !restatesTitle(promoted, host?.title)) {
    merged.groupHeading = promoted;
  }
  return merged;
}

function mergeDegenerateSections(chapters = [], options = {}) {
  if (!Array.isArray(chapters)) return [];
  if (chapters.length < 2) return chapters;

  const thresholdChars = Number(options.thresholdChars) || DEGENERATE_SECTION_CHARS;
  const oversizedChars = Number(options.oversizedChars) || OVERSIZED_CHAPTER_THRESHOLD;
  const kinds = chapters.map(chapter => degenerateSectionKind(chapter, thresholdChars));
  const inNumberedRun = numberedRunMembership(chapters);
  const degenerateCount = kinds.filter(Boolean).length;
  if (degenerateCount === 0) return chapters;
  // Density guard: a book built from short sections (poetry, aphorisms,
  // devotionals) is authored that way, and merging there would destroy its real
  // structure, so degenerate sections must be a clear minority for the "this is
  // a divider, not a chapter" reading to hold.
  //
  // A section already recognized as a divider is excluded from the count. It is
  // positive structural evidence rather than an inference from brevity, and a
  // collection that introduces every excerpt with one is exactly half dividers
  // by construction — the shape this pass exists for must not be read as the
  // shape it must decline.
  const inferredCount = kinds.filter((kind, index) => kind && chapters[index]?.type !== 'divider').length;
  if (inferredCount * 2 >= chapters.length) return chapters;

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
    merged.push(absorbSections(chapter, pending, 'before', !inNumberedRun[index]));
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
  const normalizedMetadata = chapters.map(chapter => normalizeChapterMetadata(chapter, options.work));
  // Merge before series repair: repair reads a chapter's own opening lines, so
  // it must see the sections a reader will actually hear.
  const mergedSections = mergesDegenerateSections(options.sourceFormat)
    ? mergeDividerNotesIntoExcerpt(
      coalesceAdjacentAuxiliary(mergeDegenerateSections(normalizedMetadata))
    )
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


module.exports = {
  OVERSIZED_CHAPTER_THRESHOLD,
  UNUSABLE_CHAPTER_THRESHOLD,
  DEGENERATE_MERGE_SOURCE_FORMATS,
  DEGENERATE_SECTION_CHARS,
  repairSequentialChapterSeries,
  mergeDegenerateSections,
  mergeDividerNotesIntoExcerpt,
  coalesceAdjacentAuxiliary,
  mergesDegenerateSections,
  normalizeChapterSequence,
  splitOversizedChapters
};
