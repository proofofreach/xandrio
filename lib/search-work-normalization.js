// Search providers frequently disagree about punctuation, author order, and
// whether a release label belongs in the title. Keep identity normalization
// narrow: remove edition labels, but preserve semantic scope such as volume,
// collection, adaptation, and study-guide markers.
const EDITION_DESCRIPTOR_PATTERN = String.raw`(?:the\s+)?(?:` +
  String.raw`original\s+scroll|original\s+manuscript|author['’]?s\s+preferred|` +
  String.raw`new\s+snapshots|` +
  String.raw`revised|updated|expanded|restored|corrected|unabridged|abridged|annotated|illustrated|` +
  String.raw`deluxe|collector['’]?s|anniversary|centennial|commemorative|definitive|paperback|hardcover|` +
  String.raw`ebook|e-book|kindle|digital)`;
const EDITION_IMPRINT_PATTERN = String.raw`(?:the\s+)?(?:` +
  String.raw`modern\s+library|penguin\s+classics|oxford\s+world['’]?s\s+classics|p\.?\s*s\.?)`;
const EDITION_LABEL_PATTERN = String.raw`(?:${EDITION_DESCRIPTOR_PATTERN}|${EDITION_IMPRINT_PATTERN})`;
const EDITION_ORDINAL_PATTERN = String.raw`(?:\d+(?:st|nd|rd|th)\s+)?`;
const EDITION_SUFFIX = new RegExp(
  String.raw`(?:\s*[-–—:,·]\s*${EDITION_ORDINAL_PATTERN}(?:${EDITION_LABEL_PATTERN})|\s+${EDITION_ORDINAL_PATTERN}(?:${EDITION_DESCRIPTOR_PATTERN}))(?:\s+(?:edition|version))?\s*$`,
  'i'
);
const EDITION_PARENS_PATTERN = String.raw`\s*[\[(][^\])]*(?:${EDITION_LABEL_PATTERN}|edition|version)[^\])]*[\])]`;
const EDITION_PARENS = new RegExp(EDITION_PARENS_PATTERN, 'gi');
const EDITION_PARENS_TEST = new RegExp(EDITION_PARENS_PATTERN, 'i');
const GIVEN_NAME_ABBREVIATIONS = new Map([
  ['alexr', 'alexander'],
  ['benj', 'benjamin'],
  ['chas', 'charles'],
  ['geo', 'george'],
  ['jas', 'james'],
  ['jno', 'john'],
  ['robt', 'robert'],
  ['thos', 'thomas'],
  ['wm', 'william']
]);

// Provider-controlled text (titles, authors, publishers) feeds several
// backtracking regexes in this module (notably EDITION_PARENS). Bounding
// every scan keeps pathological inputs O(1); no legitimate bibliographic
// field carries identity information past this length.
const MAX_SCAN_LENGTH = 400;
function boundedScanText(value) {
  return String(value || '').slice(0, MAX_SCAN_LENGTH);
}

function normalizeText(value) {
  return boundedScanText(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function authorTokenSignature(value) {
  return normalizeText(value)
    .replace(/\b(?:unknown|author|anonymous|n a)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .sort()
    .join(' ');
}

function authorityCleanAuthor(value) {
  return boundedScanText(value)
    .replace(/\b(?:1[5-9]\d{2}|20\d{2})\s*[-–—]\s*(?:1[5-9]\d{2}|20\d{2})?\b/g, ' ')
    .replace(/\b(?:primary|main|principal)\s+contributor\b/gi, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function creatorNames(author) {
  const cleaned = authorityCleanAuthor(author);
  if (!cleaned) return [];
  const delimited = cleaned.split(/\s*(?:;|&|\band\b)\s*/i).filter(Boolean);
  return delimited.flatMap(segment => {
    const parts = segment.split(',').map(part => part.trim()).filter(Boolean);
    if (parts.length < 2) return parts;
    const firstTokens = normalizedCreatorTokens(parts[0]);
    const secondTokens = normalizedCreatorTokens(parts[1]);
    const firstIsSurname = firstTokens.length === 1 && secondTokens.length <= 2;
    const initialPrefixedSurname = firstTokens.length === 2 && firstTokens[0].length === 1 &&
      firstTokens[1].length > 1 && secondTokens.length <= 2;
    return firstIsSurname || initialPrefixedSurname
      ? [`${parts[1]} ${parts[0]}`, ...parts.slice(2)]
      : parts;
  }).filter(Boolean);
}

function normalizedCreatorTokens(value) {
  return normalizeText(value)
    .replace(/\b(?:unknown|author|anonymous|n a)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map(token => GIVEN_NAME_ABBREVIATIONS.get(token) || token);
}

// Retain token order for alias comparison. Two-word names also expose their
// reversed form because provider metadata commonly omits the comma in
// surname-first names. Longer names expose a bounded surname-first rotation.
function creatorIdentityProfiles(author) {
  const profiles = [];
  // Work identity follows the primary creator only. Secondary contributors
  // remain available through contributorIdentities() for search intent, but
  // must never bridge works with different primary creators.
  for (const name of creatorNames(author).slice(0, 1)) {
    const tokens = normalizedCreatorTokens(name);
    if (!tokens.length) continue;
    profiles.push(tokens.join(' '));
    if (tokens.length === 2) profiles.push([...tokens].reverse().join(' '));
    else if (tokens.length > 2) profiles.push([...tokens.slice(1), tokens[0]].join(' '));

    const letters = String(name).replace(/[^A-Za-z]/g, '');
    if (tokens.length === 1 && letters.length >= 2 && letters.length <= 4 &&
        letters === letters.toUpperCase()) {
      profiles.push(`@initials-only:${letters.toLowerCase()}`);
    } else if (tokens.length >= 2 && tokens.length <= 4) {
      profiles.push(`@initials-full:${tokens.map(token => token[0]).join('')}`);
    }
  }
  return [...new Set(profiles)];
}

function compressedInitialsCompatible(leftProfile, rightProfile) {
  const leftOnly = String(leftProfile).match(/^@initials-only:([a-z]{2,4})$/)?.[1];
  const leftFull = String(leftProfile).match(/^@initials-full:([a-z]{2,4})$/)?.[1];
  const rightOnly = String(rightProfile).match(/^@initials-only:([a-z]{2,4})$/)?.[1];
  const rightFull = String(rightProfile).match(/^@initials-full:([a-z]{2,4})$/)?.[1];
  return Boolean((leftOnly && rightFull && leftOnly === rightFull) ||
    (rightOnly && leftFull && rightOnly === leftFull));
}

function nameTokenCompatible(left, right) {
  if (left === right) return true;
  return (left.length === 1 && right.startsWith(left)) ||
    (right.length === 1 && left.startsWith(right));
}

function middleNamesCompatible(left, right) {
  if (!left.length || !right.length) return true;
  const hasAnyMatch = left.some(leftToken => right.some(rightToken => nameTokenCompatible(leftToken, rightToken)));
  if (!hasAnyMatch) return false;
  const fullTokensSupported = (source, target) => source
    .filter(token => token.length > 1)
    .every(token => target.some(candidate => nameTokenCompatible(token, candidate)));
  return fullTokensSupported(left, right) && fullTokensSupported(right, left);
}

function creatorProfilesCompatible(leftProfiles, rightProfiles) {
  for (const leftProfile of leftProfiles || []) {
    for (const rightProfile of rightProfiles || []) {
      if (compressedInitialsCompatible(leftProfile, rightProfile)) return true;
      if (String(leftProfile).startsWith('@') || String(rightProfile).startsWith('@')) continue;
      const left = String(leftProfile || '').split(' ').filter(Boolean);
      const right = String(rightProfile || '').split(' ').filter(Boolean);
      if (!left.length || !right.length) continue;
      if (left.length === 1 || right.length === 1) {
        if (left.length === right.length && left[0] === right[0]) return true;
        continue;
      }
      if (left.at(-1) !== right.at(-1)) continue;
      if (!nameTokenCompatible(left[0], right[0])) continue;
      if (middleNamesCompatible(left.slice(1, -1), right.slice(1, -1))) return true;
    }
  }
  return false;
}

function contributorIdentities(author) {
  return [...new Set(creatorNames(author).map(authorTokenSignature).filter(Boolean))];
}

function primaryCreatorIdentity(author) {
  return contributorIdentities(author)[0] || '';
}

function primaryCreatorDisplay(author) {
  return creatorNames(author)[0] || String(author || '').trim();
}

function canonicalWorkTitle(title) {
  let cleaned = boundedScanText(title)
    .replace(EDITION_PARENS, ' ')
    .replace(/\s*:\s*(?:a\s+)?(?:novel|memoir|autobiography)\s*$/i, '')
    .replace(/[\s:;,·\-–—]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  let previous;
  do {
    previous = cleaned;
    cleaned = cleaned.replace(EDITION_SUFFIX, '').replace(/[\s:;,·\-–—]+$/g, '').trim();
  } while (cleaned && cleaned !== previous);

  return normalizeText(cleaned);
}

function hasEditionTitleLabel(title) {
  const value = boundedScanText(title);
  return EDITION_PARENS_TEST.test(value) || EDITION_SUFFIX.test(value);
}

function fallbackWorkIdentity(result = {}) {
  const title = canonicalWorkTitle(result.title);
  const author = primaryCreatorIdentity(result.author);
  if (!title) return `unidentified:${normalizeText(result.source)}:${normalizeText(result.hash)}`;
  return `${title}|${author || 'unknown'}`;
}

function normalizedOpenLibraryWorkKey(value) {
  const key = String(value || '').trim().replace(/^\/+/, '');
  return key ? key.toLowerCase() : '';
}

function normalizeLanguage(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  const names = {
    english: 'en', eng: 'en', german: 'de', deutsch: 'de', deu: 'de', ger: 'de',
    spanish: 'es', espanol: 'es', 'español': 'es', spa: 'es',
    french: 'fr', francais: 'fr', 'français': 'fr', fra: 'fr', fre: 'fr',
    italian: 'it', italiano: 'it', ita: 'it', portuguese: 'pt', portugues: 'pt',
    'português': 'pt', por: 'pt', russian: 'ru', rus: 'ru', chinese: 'zh', zho: 'zh',
    chi: 'zh', japanese: 'ja', jpn: 'ja'
  };
  if (names[raw]) return names[raw];
  const code = raw.match(/^[a-z]{2,3}(?:[-_][a-z]{2,4})?/i)?.[0];
  return code ? (names[code] || code.slice(0, 2)) : normalizeText(raw);
}

function normalizePublisher(value) {
  return normalizeText(boundedScanText(value)
    .replace(/\b(?:1[5-9]\d{2}|20\d{2})\b/g, ' ')
    .replace(/\b(?:published|publisher|publication)\b/gi, ' '));
}

function validIsbn10(value) {
  if (!/^\d{9}[\dX]$/.test(value)) return false;
  const total = [...value].reduce((sum, char, index) =>
    sum + (char === 'X' ? 10 : Number(char)) * (10 - index), 0);
  return total % 11 === 0;
}

function validIsbn13(value) {
  if (!/^\d{13}$/.test(value)) return false;
  const total = [...value].reduce((sum, char, index) =>
    sum + Number(char) * (index % 2 === 0 ? 1 : 3), 0);
  return total % 10 === 0;
}

function isbn10To13(value) {
  const stem = `978${value.slice(0, 9)}`;
  const total = [...stem].reduce((sum, char, index) =>
    sum + Number(char) * (index % 2 === 0 ? 1 : 3), 0);
  return `${stem}${(10 - (total % 10)) % 10}`;
}

function normalizedIsbns(value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  const normalized = new Set();
  for (const raw of values) {
    const pieces = String(raw).toUpperCase().match(/[\dX][\dX\s-]{8,20}/g) || [];
    for (const piece of pieces) {
      const clean = piece.replace(/[^\dX]/g, '');
      if (validIsbn13(clean)) normalized.add(clean);
      else if (validIsbn10(clean)) normalized.add(isbn10To13(clean));
    }
  }
  return [...normalized].sort();
}

function volumeSignature(title) {
  const normalized = normalizeText(title);
  const match = normalized.match(/\b(?:volume|vol|book|part|tome|band)\s+([0-9]+|[ivxlcdm]+)(?:\s+of\s+([0-9]+|[ivxlcdm]+))?/i);
  return match ? `${match[1]}${match[2] ? `/${match[2]}` : ''}` : '';
}

function collectionScope(title) {
  const value = boundedScanText(title);
  if (!value.trim()) return 'unknown';
  const marker = /\b(?:complete|collected|selected)\s+(?:works|stories|poems|novels|plays|essays)\b|\b(?:complete collection|omnibus|anthology)\b/i;
  const match = marker.exec(value);
  if (!match) return 'individual';

  // A collection label nested after a substantive title identifies the
  // constituent's container, not the constituent itself.
  const prefix = value.slice(0, match.index);
  if (/[\[(][^\])]*$/u.test(prefix)) return 'constituent';
  return 'collection';
}

function contentQualifiers(title) {
  const value = boundedScanText(title);
  return {
    volume: volumeSignature(value),
    derivative: /\b(study guide|summary|analysis|workbook|companion|sparknotes|cliffsnotes|book notes)\b/i.test(value),
    adapted: /\b(adapted|adaptation|retold|retelling|dramatization|dramatisation|graphic (?:novel|version))\b/i.test(value),
    abridgement: /\bunabridged\b/i.test(value) ? 'full' : /\babridged\b/i.test(value) ? 'abridged' : 'unknown',
    textualVersion: /\boriginal (?:scroll|manuscript)\b/i.test(value) ? 'original-manuscript' : '',
    collectionScope: collectionScope(value)
  };
}

module.exports = {
  normalizeText,
  creatorNames,
  creatorIdentityProfiles,
  creatorProfilesCompatible,
  contributorIdentities,
  primaryCreatorIdentity,
  primaryCreatorDisplay,
  canonicalWorkTitle,
  hasEditionTitleLabel,
  fallbackWorkIdentity,
  normalizedOpenLibraryWorkKey,
  normalizeLanguage,
  normalizePublisher,
  normalizedIsbns,
  contentQualifiers
};
