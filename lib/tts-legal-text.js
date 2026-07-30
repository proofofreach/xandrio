const {
  integerToCardinalWords,
  integerToOrdinalWords,
  numericOrdinalToWords,
  romanProvisionToWords,
  romanToInteger,
  yearToWords
} = require('./tts-number-words');

const REPORTERS = new Map([
  ['All ER', 'All E R'],
  ['U.S.', 'U S'],
  ['S. Ct.', 'Supreme Court Reporter'],
  ['L. Ed. 3d', 'Lawyers Edition third series'],
  ['L. Ed. 2d', 'Lawyers Edition second series'],
  ['L. Ed.', 'Lawyers Edition'],
  ['F. Supp. 2d', 'Federal Supplement second series'],
  ['F. Supp. 3d', 'Federal Supplement third series'],
  ['F. Supp.', 'Federal Supplement'],
  ['F.2d', 'Federal Reporter second series'],
  ['F.3d', 'Federal Reporter third series'],
  ['F.4th', 'Federal Reporter fourth series'],
  ['CLR', 'C L R'],
  ['ALJR', 'A L J R'],
  ['ALR', 'A L R'],
  ['NSWLR', 'N S W L R'],
  ['WLR', 'W L R'],
  ['AC', 'A C'],
  ['QB', 'Q B'],
  ['KB', 'K B'],
  ['Ch', 'Chancery']
]);

const COURT_CODES = new Set([
  'ACTSC', 'FCA', 'FCAFC', 'FAMCA', 'HCA', 'NSWCA', 'NSWCCA', 'NSWSC',
  'NTSC', 'QCA', 'QSC', 'SASC', 'SASCA', 'TASFC', 'TASSC', 'UKHL', 'UKSC',
  'VCA', 'VSCA', 'VSC', 'WASCA', 'WASC', 'EWCA', 'EWHC', 'NZCA', 'NZSC',
  'SCOTCS', 'CSIH', 'CSOH'
]);

const JURISDICTIONS = new Map([
  ['ACT', 'Australian Capital Territory'],
  ['Cth', 'Commonwealth'],
  ['NSW', 'New South Wales'],
  ['NT', 'Northern Territory'],
  ['Qld', 'Queensland'],
  ['SA', 'South Australia'],
  ['Tas', 'Tasmania'],
  ['UK', 'United Kingdom'],
  ['US', 'United States'],
  ['Vic', 'Victoria'],
  ['WA', 'Western Australia']
]);

const MARKERS = new Map([
  ['sub-ss', ['subsections', 'subsections']],
  ['sub-s', ['subsection', 'subsections']],
  ['subsection', ['subsection', 'subsections']],
  ['subsections', ['subsections', 'subsections']],
  ['s', ['section', 'sections']],
  ['ss', ['sections', 'sections']],
  ['section', ['section', 'sections']],
  ['sections', ['sections', 'sections']],
  ['§', ['section', 'sections']],
  ['§§', ['sections', 'sections']],
  ['pt', ['Part', 'Parts']],
  ['pts', ['Parts', 'Parts']],
  ['part', ['Part', 'Parts']],
  ['parts', ['Parts', 'Parts']],
  ['div', ['Division', 'Divisions']],
  ['divs', ['Divisions', 'Divisions']],
  ['division', ['Division', 'Divisions']],
  ['divisions', ['Divisions', 'Divisions']],
  ['sch', ['Schedule', 'Schedules']],
  ['schs', ['Schedules', 'Schedules']],
  ['schedule', ['Schedule', 'Schedules']],
  ['schedules', ['Schedules', 'Schedules']],
  ['reg', ['regulation', 'regulations']],
  ['regs', ['regulations', 'regulations']],
  ['regulation', ['regulation', 'regulations']],
  ['regulations', ['regulations', 'regulations']],
  ['cl', ['clause', 'clauses']],
  ['cls', ['clauses', 'clauses']],
  ['clause', ['clause', 'clauses']],
  ['clauses', ['clauses', 'clauses']],
  ['r', ['rule', 'rules']],
  ['rr', ['rules', 'rules']],
  ['rule', ['rule', 'rules']],
  ['rules', ['rules', 'rules']],
  ['para', ['paragraph', 'paragraphs']],
  ['paras', ['paragraphs', 'paragraphs']],
  ['paragraph', ['paragraph', 'paragraphs']],
  ['paragraphs', ['paragraphs', 'paragraphs']],
  ['art', ['Article', 'Articles']],
  ['arts', ['Articles', 'Articles']],
  ['article', ['Article', 'Articles']],
  ['articles', ['Articles', 'Articles']],
  ['vol', ['volume', 'volumes']],
  ['vols', ['volumes', 'volumes']],
  ['volume', ['volume', 'volumes']],
  ['volumes', ['volumes', 'volumes']],
  ['n', ['note', 'notes']],
  ['nn', ['notes', 'notes']],
  ['note', ['note', 'notes']],
  ['notes', ['notes', 'notes']],
  ['p', ['page', 'pages']],
  ['pp', ['pages', 'pages']],
  ['page', ['page', 'pages']],
  ['pages', ['pages', 'pages']],
  ['no', ['Number', 'Numbers']],
  ['nos', ['Numbers', 'Numbers']],
  ['number', ['Number', 'Numbers']],
  ['numbers', ['Numbers', 'Numbers']],
  ['amendment', ['Amendment', 'Amendments']],
  ['amendments', ['Amendments', 'Amendments']]
]);

const LEGAL_INITIALISMS = new Set([
  ...COURT_CODES,
  ...[...REPORTERS.keys()].map(value => value.replace(/[^A-Za-z]/g, '').toUpperCase()),
  'NSW', 'ACT', 'QLD', 'VIC', 'TAS', 'CTH'
]);

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function flexibleTokenPattern(value) {
  return String(value).split(/\s+/).map(escapeRegExp).join('\\s+');
}

const REPORTER_PATTERN = [...REPORTERS.keys()]
  .sort((left, right) => right.length - left.length)
  .map(flexibleTokenPattern)
  .join('|');
const COURT_PATTERN = [...COURT_CODES]
  .sort((left, right) => right.length - left.length)
  .map(escapeRegExp)
  .join('|');
const MARKER_PATTERN = [...MARKERS.keys()]
  .sort((left, right) => right.length - left.length)
  .map(escapeRegExp)
  .join('|');

const NUMERIC_BASE_PATTERN = '\\d{1,6}(?:\\.\\d{1,6})*[A-Za-z]?';
const SUBDIVISION_PATTERN = '(?:\\([A-Za-z0-9]+\\))*';
const REFERENCE_ATOM_PATTERN = `${NUMERIC_BASE_PATTERN}${SUBDIVISION_PATTERN}`;
const REFERENCE_END_PATTERN = `(?:${REFERENCE_ATOM_PATTERN}|\\([A-Za-z0-9]+\\))`;
const REFERENCE_RANGE_PATTERN = `${REFERENCE_ATOM_PATTERN}(?:\\s*[–—-]\\s*${REFERENCE_END_PATTERN})?`;
const LEGAL_CODE_FOLLOW_PATTERN = `(?:${REPORTER_PATTERN}|${COURT_PATTERN}|U\\.?\\s*S\\.?\\s*C\\.?|C\\.?\\s*F\\.?\\s*R\\.?)`;
const SAFE_REFERENCE_RANGE_PATTERN = `${REFERENCE_RANGE_PATTERN}(?!\\s+${LEGAL_CODE_FOLLOW_PATTERN})`;
const REFERENCE_LIST_PATTERN = `${SAFE_REFERENCE_RANGE_PATTERN}(?:\\s*(?:,\\s*|(?:and|or)\\s+|&\\s*)${SAFE_REFERENCE_RANGE_PATTERN})*`;

function spellInitialism(value) {
  return String(value).replace(/[^A-Za-z]/g, '').toUpperCase().split('').join(' ');
}

function reporterSpokenForm(value) {
  const compact = String(value).replace(/\s+/g, ' ').trim();
  for (const [reporter, spoken] of REPORTERS) {
    if (reporter.toLowerCase() === compact.toLowerCase()) return spoken;
  }
  return spellInitialism(compact);
}

function expandShortRangeEnd(start, end) {
  const startDigits = String(start);
  const endDigits = String(end);
  if (endDigits.length >= startDigits.length) return endDigits;
  const magnitude = 10 ** endDigits.length;
  let candidate = Number(startDigits.slice(0, startDigits.length - endDigits.length) + endDigits);
  if (candidate < Number(startDigits)) candidate += magnitude;
  return String(candidate);
}

function formatNumericBase(value) {
  const match = String(value).match(/^(\d+(?:\.\d+)*)([A-Za-z]?)$/);
  if (!match) return value;
  const spoken = match[1].split('.').map(part => integerToCardinalWords(part)).join(' point ');
  return `${spoken}${match[2] ? ` ${match[2].toUpperCase()}` : ''}`;
}

function subdivisionValue(value, priorValues = []) {
  if (/^\d+[A-Za-z]?$/.test(value)) return formatNumericBase(value);
  const isRomanSubparagraph = priorValues.some(item => /^[A-Za-z]+$/.test(item)) &&
    romanToInteger(value) !== null;
  if (isRomanSubparagraph) return integerToCardinalWords(romanToInteger(value));
  return String(value).toUpperCase().split('').join(' ');
}

function subdivisionLabel(value, priorValues = []) {
  if (/^\d+[A-Za-z]?$/.test(value)) return 'subsection';
  if (priorValues.some(item => /^[A-Za-z]+$/.test(item)) && romanToInteger(value) !== null) {
    return 'subparagraph';
  }
  return 'paragraph';
}

function pluralizeSubdivision(label) {
  return `${label}s`;
}

function parseReferenceAtom(value) {
  const match = String(value).match(/^(\d+(?:\.\d+)*[A-Za-z]?)((?:\([A-Za-z0-9]+\))*)$/);
  if (!match) return null;
  return {
    base: match[1],
    groups: [...match[2].matchAll(/\(([A-Za-z0-9]+)\)/g)].map(group => group[1])
  };
}

function formatReferenceAtom(value) {
  const parsed = parseReferenceAtom(value);
  if (!parsed) return value;
  let spoken = formatNumericBase(parsed.base);
  parsed.groups.forEach((group, index) => {
    const prior = parsed.groups.slice(0, index);
    spoken += `, ${subdivisionLabel(group, prior)} ${subdivisionValue(group, prior)}`;
  });
  return spoken;
}

function formatNestedSubdivisionRange(start, endGroup) {
  const parsed = parseReferenceAtom(start);
  if (!parsed || parsed.groups.length === 0) return null;
  const startGroup = parsed.groups.at(-1);
  const prior = parsed.groups.slice(0, -1);
  let spoken = formatNumericBase(parsed.base);
  prior.forEach((group, index) => {
    const earlier = prior.slice(0, index);
    spoken += `, ${subdivisionLabel(group, earlier)} ${subdivisionValue(group, earlier)}`;
  });
  const label = subdivisionLabel(startGroup, prior);
  return `${spoken}, ${pluralizeSubdivision(label)} ${subdivisionValue(startGroup, prior)} through ${subdivisionValue(endGroup, prior)}`;
}

function formatReferenceRange(value) {
  const match = String(value).match(new RegExp(
    `^(${REFERENCE_ATOM_PATTERN})(?:\\s*[–—-]\\s*(${REFERENCE_END_PATTERN}))?$`,
    'u'
  ));
  if (!match || !match[2]) return formatReferenceAtom(value);

  if (/^\([A-Za-z0-9]+\)$/.test(match[2])) {
    const nested = formatNestedSubdivisionRange(match[1], match[2].slice(1, -1));
    if (nested) return nested;
  }

  const start = parseReferenceAtom(match[1]);
  const end = parseReferenceAtom(match[2]);
  if (!start || !end) return value;
  if (/^\d+$/.test(start.base) && /^\d+$/.test(end.base) && end.groups.length === 0) {
    end.base = expandShortRangeEnd(start.base, end.base);
  }
  return `${formatReferenceAtom(match[1])} through ${formatReferenceAtom(
    `${end.base}${end.groups.map(group => `(${group})`).join('')}`
  )}`;
}

function markerInfo(value) {
  const key = String(value).replace(/\.$/, '').toLowerCase();
  return MARKERS.get(key);
}

function normalizeLegalReferences(text) {
  const referenceList = new RegExp(REFERENCE_RANGE_PATTERN, 'gu');
  const pattern = new RegExp(
    `(^|[^\\p{L}\\p{N}_])(${MARKER_PATTERN})(?:\\.\\s*|\\s+|(?<=§))(${REFERENCE_LIST_PATTERN})(?=$|[^\\p{L}\\p{N}_])`,
    'gimu'
  );
  return String(text).replace(pattern, (_match, prefix, marker, references) => {
    const info = markerInfo(marker);
    if (!info) return _match;
    const values = [...references.matchAll(referenceList)];
    const multiple = values.length > 1 || values.some(item =>
      /[–—-]/.test(item[0]) && !/\)\s*[–—-]\s*\(/.test(item[0])
    );
    let cursor = 0;
    let spokenReferences = '';
    for (const value of values) {
      spokenReferences += references.slice(cursor, value.index) + formatReferenceRange(value[0]);
      cursor = value.index + value[0].length;
    }
    spokenReferences += references.slice(cursor);
    spokenReferences = spokenReferences.replace(/&/g, 'and');
    return `${prefix}${multiple ? info[1] : info[0]} ${spokenReferences}`;
  });
}

function normalizeStatutoryCodes(text) {
  const pattern = /\b(\d{1,4})\s+(U\.?\s*S\.?\s*C\.?|C\.?\s*F\.?\s*R\.?)(?=\s*§)/giu;
  return String(text).replace(pattern, (_match, title, code) =>
    `title ${integerToCardinalWords(title)} ${spellInitialism(code)},`
  );
}

function spokenDateDay(digits, suffix = '') {
  const day = Number(digits);
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  return suffix
    ? numericOrdinalToWords(String(day), suffix)
    : integerToOrdinalWords(day);
}

function normalizeCalendarDates(text) {
  const months = 'January|February|March|April|May|June|July|August|September|October|November|December';
  let result = String(text).replace(
    new RegExp(`\\b(${months})\\s+([0-3]?\\d)(st|nd|rd|th)?,\\s+(\\d{4})\\b`, 'giu'),
    (match, month, day, suffix, year) => {
      const spokenDay = spokenDateDay(day, suffix);
      return spokenDay ? `${month} ${spokenDay}, ${yearToWords(year)}` : match;
    }
  );
  result = result.replace(
    new RegExp(`\\b([0-3]?\\d)(st|nd|rd|th)?\\s+(${months})\\s+(\\d{4})\\b`, 'giu'),
    (match, day, suffix, month, year) => {
      const spokenDay = spokenDateDay(day, suffix);
      return spokenDay ? `the ${spokenDay} of ${month}, ${yearToWords(year)}` : match;
    }
  );
  return result;
}

function normalizeRomanLegalReferences(text) {
  const romanMarkers = [
    'pt', 'pts', 'part', 'parts', 'div', 'divs', 'division', 'divisions',
    'sch', 'schs', 'schedule', 'schedules', 'art', 'arts', 'article',
    'articles', 'amendment', 'amendments'
  ].sort((left, right) => right.length - left.length).map(escapeRegExp).join('|');
  const pattern = new RegExp(
    `(^|[^\\p{L}\\p{N}_])(${romanMarkers})\\.?\\s+([IVXLCDM]+[A-Z]?)(?:\\s*[–—-]\\s*([IVXLCDM]+[A-Z]?))?(?=$|[^\\p{L}\\p{N}_])`,
    'gimu'
  );
  return String(text).replace(pattern, (match, prefix, marker, start, end) => {
    const info = markerInfo(marker);
    const first = romanProvisionToWords(start);
    const last = end && romanProvisionToWords(end);
    if (!info || !first || (end && !last)) return match;
    return `${prefix}${end ? info[1] : info[0]} ${first}${end ? ` through ${last}` : ''}`;
  });
}

function normalizeStatuteYears(text) {
  const pattern = /\b((?:[\p{L}][\p{L}'’.-]*\s+){0,12}(?:Act|Code|Rules?|Regulations?|Ordinance|Charter|Constitution))\s+(\d{4})(?:\s+\(([A-Za-z]{2,4})\))?/gu;
  return String(text).replace(pattern, (match, title, year, jurisdiction) => {
    const spokenJurisdiction = jurisdiction &&
      [...JURISDICTIONS].find(([key]) => key.toLowerCase() === jurisdiction.toLowerCase())?.[1];
    return `${title} ${yearToWords(year)}${spokenJurisdiction ? `, ${spokenJurisdiction}` : (jurisdiction ? ` (${jurisdiction})` : '')}`;
  });
}

function normalizeLeadingReporterCitations(text) {
  const pattern = new RegExp(
    `(^|\\s+)(?:\\((\\d{4})\\)|\\[(\\d{4})\\])\\s+(\\d{1,4})\\s+(${REPORTER_PATTERN})\\s+(\\d{1,6})(?:\\s*[–—-]\\s*(\\d{1,6}))?`,
    'gimu'
  );
  return String(text).replace(pattern, (match, spacing, parentheticalYear, bracketedYear, volume, reporter, page, pageEnd, offset) => {
    const year = parentheticalYear || bracketedYear;
    const end = pageEnd ? expandShortRangeEnd(page, pageEnd) : null;
    const citation = `${yearToWords(year)}, volume ${integerToCardinalWords(volume)} ${reporterSpokenForm(reporter)}, page ${integerToCardinalWords(page)}` +
      (end ? ` through ${integerToCardinalWords(end)}` : '');
    return `${offset > 0 && spacing ? ', ' : ''}${citation}`;
  });
}

function normalizeTrailingReporterCitations(text) {
  const pattern = new RegExp(
    `(\\d{1,4})\\s+(${REPORTER_PATTERN})\\s+(\\d{1,6})(?:\\s*[–—-]\\s*(\\d{1,6}))?\\s+\\((?:([^()]*?\\S)\\s+)?(\\d{4})\\)`,
    'gimu'
  );
  return String(text).replace(pattern, (_match, volume, reporter, page, pageEnd, court, year) => {
    const end = pageEnd ? expandShortRangeEnd(page, pageEnd) : null;
    return `volume ${integerToCardinalWords(volume)} ${reporterSpokenForm(reporter)}, page ${integerToCardinalWords(page)}` +
      (end ? ` through ${integerToCardinalWords(end)}` : '') +
      (court ? `, ${courtParentheticalToWords(court)}` : '') +
      `, ${yearToWords(year)}`;
  });
}

function normalizeBareReporterCitations(text) {
  const pattern = new RegExp(
    `(\\d{1,4})\\s+(${REPORTER_PATTERN})\\s+(\\d{1,6})(?:\\s*[–—-]\\s*(\\d{1,6}))?`,
    'gimu'
  );
  return String(text).replace(pattern, (_match, volume, reporter, page, pageEnd) => {
    const end = pageEnd ? expandShortRangeEnd(page, pageEnd) : null;
    return `volume ${integerToCardinalWords(volume)} ${reporterSpokenForm(reporter)}, page ${integerToCardinalWords(page)}` +
      (end ? ` through ${integerToCardinalWords(end)}` : '');
  });
}

function normalizeNeutralCitations(text) {
  const pattern = new RegExp(
    `(^|\\s+)(?:\\((\\d{4})\\)|\\[(\\d{4})\\])\\s+(${COURT_PATTERN})(?:\\s+(Civ|Crim|Admin|Fam|Ch|Comm))?\\s+(\\d{1,6})`,
    'gimu'
  );
  return String(text).replace(pattern, (match, spacing, parentheticalYear, bracketedYear, court, division, caseNumber, offset) => {
    const year = parentheticalYear || bracketedYear;
    const divisions = {
      civ: 'Civil',
      crim: 'Criminal',
      admin: 'Administrative',
      fam: 'Family',
      ch: 'Chancery',
      comm: 'Commercial'
    };
    const citation = `${yearToWords(year)}, ${spellInitialism(court)}` +
      (division ? ` ${divisions[division.toLowerCase()]}` : '') +
      `, case ${integerToCardinalWords(caseNumber)}`;
    return `${offset > 0 && spacing ? ', ' : ''}${citation}`;
  });
}

function courtParentheticalToWords(value) {
  const compact = String(value).replace(/\s+/g, ' ').trim();
  const circuit = compact.match(/^(\d+)(st|nd|rd|th)\s+Cir\.?$/i);
  if (circuit) {
    const ordinal = numericOrdinalToWords(circuit[1], circuit[2]);
    if (ordinal) return `${ordinal} Circuit`;
  }
  if (/^[A-Za-z.]+$/.test(compact)) return spellInitialism(compact);
  return compact;
}

function normalizePinpoints(text) {
  let result = String(text).replace(
    /\bat\s+\[(\d{1,6})\](?:\s*[–—-]\s*\[(\d{1,6})\])?/giu,
    (_match, start, end) => `at paragraph ${integerToCardinalWords(start)}` +
      (end ? ` through ${integerToCardinalWords(expandShortRangeEnd(start, end))}` : '')
  );
  result = result.replace(
    /(^|[,;]\s*)at\s+(\d{1,6})(?:\s*[–—-]\s*(\d{1,6}))?/gimu,
    (_match, prefix, start, end) => `${prefix}at ${integerToCardinalWords(start)}` +
      (end ? ` through ${integerToCardinalWords(expandShortRangeEnd(start, end))}` : '')
  );
  return result;
}

function normalizeCaseVersus(text) {
  return String(text).replace(
    /\b([A-Z][\p{L}'’.-]*)\s+v\.?\s+(?=[A-Z][\p{L}'’.-]*\b)/gu,
    '$1 versus '
  );
}

function normalizeLegalCitations(text) {
  let result = normalizeCalendarDates(text);
  result = normalizeTrailingReporterCitations(result);
  result = normalizeLeadingReporterCitations(result);
  result = normalizeNeutralCitations(result);
  result = normalizeBareReporterCitations(result);
  result = normalizeStatuteYears(result);
  result = normalizeStatutoryCodes(result);
  result = normalizeRomanLegalReferences(result);
  result = normalizeLegalReferences(result);
  result = normalizePinpoints(result);
  return normalizeCaseVersus(result);
}

module.exports = {
  LEGAL_INITIALISMS,
  normalizeLegalCitations,
  expandShortRangeEnd
};
