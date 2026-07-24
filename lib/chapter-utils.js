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
  if (/^(?:table\s+of\s+)?contents\b/i.test(firstLine) || numberedContentsLines >= 3) {
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
    /\b(?:prolific author|direct disciple|was born|is the author of|has written|founded)\b/i.test(prefix)
  ) {
    const person = lines.find(line =>
      /^(?:(?:Dr\.|Sri|Swami|Paramhansa|Paramahansa)\s+)?[A-Z][\p{L}'’.-]+(?:\s+[A-Z][\p{L}'’.-]+){1,4}$/u.test(line) &&
      !/^(?:Chapter|Praise|Copyright|Contents|Introduction|Foreword)\b/i.test(line)
    );
    if (person) return { title: `About ${person}`, type: 'author' };
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
  const derivedTitle = deriveHeadingTitleFromText(chapter.text || '');
  const currentTitle = String(chapter.title || '').trim();
  const structural = structuralChapterMetadata(chapter, derivedTitle);
  if (structural) {
    const next = {
      ...chapter,
      title: structural.title,
      type: structural.type
    };
    if (currentTitle && currentTitle !== structural.title) next.rawTitle = chapter.rawTitle || chapter.title;
    return next;
  }
  const currentIsChapter = isChapterLikeTitle(currentTitle);
  if (!derivedTitle && currentIsChapter && chapter.type === 'frontmatter') {
    return {
      ...chapter,
      rawTitle: chapter.rawTitle || chapter.title,
      title: 'Front Matter'
    };
  }

  if (!derivedTitle) return chapter;

  const derivedIsChapter = isChapterLikeTitle(derivedTitle);
  const trustedTocTitle = chapter.fromToc === true || chapter.tocTitleSource === 'href';
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

function normalizeChapterSequence(chapters = []) {
  if (!Array.isArray(chapters)) return [];
  const normalized = chapters.map((chapter, index) => ({
    ...normalizeChapterMetadata(chapter),
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
  const targetChars = Math.min(
    Number(options.targetChars) || REPAIRED_CHAPTER_TARGET,
    thresholdChars - 1
  );
  const repaired = [];

  for (const chapter of chapters) {
    const text = String(chapter?.text || '').trim();
    if (!chapter || text.length <= thresholdChars) {
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
  const cleaned = String(title || '')
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

  const firstSentence = cleaned.match(/^(.{1,80}?)[.!?](?:\s+[A-Z"']|$)/);
  const splitLooksLikeInitial = firstSentence && /\b[A-Z]$/.test(firstSentence[1]);
  const candidate = (firstSentence && !splitLooksLikeInitial ? firstSentence[1] : cleaned).trim();
  if (!candidate || candidate.length > 60) return '';

  const words = candidate.split(/\s+/);
  if (words.length > 8) return '';
  if (/^(it|this|that|there|he|she|they|we|i|you)\b/i.test(candidate)) return '';
  if (/\b(was|were|is|are|am|had|has|have|said|says|went|came|looked|thought)\b/i.test(candidate) && words.length > 3) return '';

  if (/(?:\b[A-Z]\.){1,}$/.test(candidate)) return candidate;
  return candidate.replace(/[:.\-–—]+$/, '').trim();
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
function repairTextArtifacts(text) {
  return String(text || '')
    .replace(/[­​‌‍﻿]/g, '')
    .replace(/([A-Za-z])-[ \t]+(?!(?:and|or|to|nor|but)\b)(?=[a-z])/g, '$1-');
}

function stripHTML(html) {
  return repairTextArtifacts(html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    // Invisible characters: soft hyphens (literal and entity forms) and
    // zero-width chars split words for TTS engines while being
    // unrenderable for readers. Must run before entity decoding, or
    // &shy; falls through to the generic entity→space rule mid-word.
    .replace(/[­​‌‍﻿]|&shy;|&#173;|&#xad;/gi, '')
    // Data tables narrate as an unlistenable number stream. Drop tables
    // where at least half the cells are numeric; keep prose laid out in
    // tables (verse, dialogue, layout tables) intact.
    .replace(/<table[^>]*>[\s\S]*?<\/table>/gi, (table) => {
      const cells = [...table.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
        .map(m => m[1].replace(/<[^>]+>/g, ' ').trim())
        .filter(Boolean);
      if (cells.length < 4) return table;
      const numericCells = cells.filter(c => /^[\d\s.,:;%°'′″/⁄½¼¾¾+±()-]+$/u.test(c)).length;
      return numericCells / cells.length >= 0.5 ? '\n' : table;
    })
    // A source line wrap after a hyphen (with or without trailing space)
    // splits a compound word ("self- \ncriticism"); rejoin it — unless the
    // next word is a coordination ("copper- and iron-tipped"), where the
    // suspended hyphen's space is real.
    .replace(/-[ \t]*[\r\n]+[ \t]*(?!(?:and|or|to|nor|but)\b)(?=[a-z])/g, '-')
    // HTML source whitespace collapses like a browser renders it: newlines
    // inside text (pretty-printed/hard-wrapped XHTML) are just spaces. Real
    // line breaks come only from the block-tag and <br> rules below —
    // otherwise mid-sentence source wraps become audible TTS pauses.
    .replace(/[\r\n\t\f\v]+/g, ' ')
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
    .replace(/\u00a0/g, ' ')
    // Letter-by-letter spaced caps ("W I N N I E" → "WINNIE"): require a run
    // of 3+ single capitals so real words ("A Canticle") are never joined.
    .replace(/\b[A-Z](?:\s+[A-Z]\b){2,}(?![a-z])/g, m => m.replace(/\s+/g, ''))
    // Styled small-caps first letter ("W INNIE" → "WINNIE"). Exclude A/I,
    // which are legitimate single-letter English words ("A CANTICLE", "I AM").
    .replace(/\b([B-HJ-Z])\s+([A-Z]{2,})\b/g, '$1$2')
    .replace(/([A-Z])-\s+([A-Z])/g, '$1-$2')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n/g, '\n\n')
    // Drop-cap repair: a lone capital on its own line (optionally preceded by
    // an opening quote) whose word continues lowercase on the next line —
    // produced by drop-cap markup like <td><span>B</span></td>...<p>rother...
    .replace(/(^|\n)([ \t]*["“'‘]?[ \t]*)([A-Z])[ \t]*\n+[ \t]*(?=[a-z])/g, '$1$2$3')
    // Digit headings split across spans ("2 4" alone on a line → "24")
    .replace(/(^|\n)[ \t]*(\d(?:[ \t]+\d)+)[ \t]*(?=\n|$)/g, (_m, pre, digits) => pre + digits.replace(/[ \t]+/g, ''))
    .trim());
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

function buildChapterQuality(chapters, tocCount = 0) {
  const contentChapters = chapters.filter(ch => ch.text && ch.text.length > 500);
  const emptyChapters = chapters.filter(ch => !ch.text || ch.text.length <= 500);
  const maxChapterSize = Math.max(...chapters.map(ch => ch.text ? ch.text.length : 0), 0);
  const hasGiantChapters = maxChapterSize > 100000;
  const tooFewContentChapters = contentChapters.length < 3;
  const spineTocMismatch = tocCount > chapters.length * 2;
  const isGoodStructure = !hasGiantChapters && !spineTocMismatch && !tooFewContentChapters;

  return {
    isGoodStructure,
    totalChapters: chapters.length,
    contentChapters: contentChapters.length,
    emptyChapters: emptyChapters.length,
    maxChapterSize,
    tocEntries: tocCount,
    reasons: [
      hasGiantChapters ? `Giant chapter: ${Math.floor(maxChapterSize / 1000)}K chars` : null,
      spineTocMismatch ? `TOC has ${tocCount} entries but only ${chapters.length} spine items` : null,
      tooFewContentChapters ? `Only ${contentChapters.length} content chapters` : null
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
  const substantialChapters = chapters.filter(chapter => (chapter.text || '').trim().length >= 500).length;

  if (totalChars < 50000) {
    validationResult.errors.push(`Insufficient content for audiobook: only ${totalChars} chars total`);
    return validationResult;
  }

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
  isChapterOneTitle,
  isChapterLikeTitle,
  normalizeChapterMetadata,
  normalizeChapterType,
  normalizeChapterSequence,
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
