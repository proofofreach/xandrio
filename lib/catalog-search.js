const { buildSearchWorks, applySearchIntent } = require('./search-work-groups');
const { boundedQueryTypoEvidence } = require('./search-fuzzy-matching');
const { normalizeText, contributorIdentities } = require('./search-work-normalization');
const {
  calculateQualityScore,
  parseSizeToBytes,
  sourceFileQualityPenalty
} = require('./search-utils');

function normalizeSearchLanguage(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';

  const bracketMatch = raw.match(/\[([a-z]{2,3})\]/i);
  if (bracketMatch) return bracketMatch[1].toLowerCase();

  const names = {
    english: 'en',
    deutsch: 'de',
    german: 'de',
    spanish: 'es',
    espanol: 'es',
    'español': 'es',
    french: 'fr',
    francais: 'fr',
    'français': 'fr',
    italian: 'it',
    italiano: 'it',
    portuguese: 'pt',
    portugues: 'pt',
    'português': 'pt',
    russian: 'ru',
    chinese: 'zh',
    japanese: 'ja'
  };

  if (names[raw]) return names[raw];

  const codeMatch = raw.match(/^[a-z]{2,3}(?:[-_][a-z]{2,4})?$/i);
  return codeMatch ? codeMatch[0].split(/[-_]/)[0].toLowerCase() : raw;
}

// A real book title is short. The normalization chain below is quadratic on
// adversarial input -- `\s*\(`, `\s*\[` and `\s*:` each rescan from every
// position when the following character never matches -- so 200k tab
// characters blocked the event loop for ~100 seconds. Both call sites are
// reachable by an attacker: the raw search query, and titles returned by
// providers the threat model treats as hostile. Bounding the input first makes
// the worst case trivial without changing any real title.
const MAX_NORMALIZED_TITLE_CHARS = 300;

function normalizeTitle(title) {
  return String(title || '')
    .slice(0, MAX_NORMALIZED_TITLE_CHARS)
    .toLowerCase()
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\s*\[[^\]]*\]/g, '')
    .replace(/\s*:\s*.*/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractYear(publisher) {
  if (!publisher) return null;
  const match = publisher.match(/(19|20)\d{2}/);
  return match ? parseInt(match[0], 10) : null;
}

function hasQueryTerm(query, pattern) {
  return pattern.test(String(query || '').toLowerCase());
}

function searchResultPenalty(result, query, { ignoreLength = false } = {}) {
  const title = String(result?.title || '').toLowerCase();
  const author = String(result?.author || '').toLowerCase();
  let penalty = 0;
  const labels = [];
  const adaptationPatterns = [
    { name: 'dramatization', pattern: /\b(dramatization|dramatised|dramatized|play|stage)\b/i, value: 90 },
    { name: 'abridged', pattern: /\b(abridged|adapted|adaptation|retold|retelling)\b/i, value: 75 },
    { name: 'reboot', pattern: /\b(reboot|remix|reimagined|reimagining|modernized|modernised)\b/i, value: 130 },
    { name: 'study-guide', pattern: /\b(study guide|summary|analysis|sparknotes|cliffsnotes|book notes)\b/i, value: 120 },
    { name: 'illustrated', pattern: /\b(illustrated|annotated)\b/i, value: 25 }
  ];

  for (const item of adaptationPatterns) {
    if ((item.pattern.test(title) || item.pattern.test(author)) && !hasQueryTerm(query, item.pattern)) {
      penalty += item.value;
      labels.push(item.name);
    }
  }

  if (!ignoreLength && title.length > Math.max(80, String(query || '').length * 2.5)) {
    penalty += 35;
    labels.push('runaway-title');
  }

  return { penalty, labels };
}

function editionTitlePenalty(result, { ignoreLength = false } = {}) {
  const title = String(result?.title || '');
  let penalty = 0;
  if (/\b(centennial|anniversary|classics?|amazonclassics|barnes\s*&\s*noble|edition|annotated|illustrated|dubliners)\b/i.test(title)) {
    penalty += 40;
  }
  if (!ignoreLength && title.length > 70) penalty += 15;
  return penalty;
}

// The title before any subtitle or bracketed series note, in normalizeText form.
function mainTitleText(title) {
  return normalizeText(String(title || '')
    .slice(0, MAX_NORMALIZED_TITLE_CHARS)
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\s*\[[^\]]*\]/g, '')
    .replace(/\s*:\s*.*/g, ''));
}

// Readers often search "title author". Find the contributor the query names
// most completely, so a shared given name ("Jon") is not credited like a full
// name or a surname ("McNeill"), and so the rest of the query can be matched
// against the title alone. As in author intent, a short lone name is too
// common to count as naming the author.
function queryAuthorEvidence(queryTokens, author) {
  const queryTokenSet = new Set(queryTokens);
  let best = { coverage: 0, tokens: [] };
  for (const identity of contributorIdentities(author)) {
    const tokens = identity.split(' ').filter(token => token.length > 1);
    if (tokens.length === 0) continue;
    const matched = tokens.filter(token => queryTokenSet.has(token));
    const coverage = matched.length / tokens.length;
    if (coverage > best.coverage) best = { coverage, tokens: matched };
  }
  const fullName = best.coverage === 1 && (best.tokens.length > 1 || best.tokens[0].length >= 5);
  const named = fullName || best.tokens.some(token => token.length >= 5);
  const residual = named
    ? queryTokens.filter(token => !best.tokens.includes(token)).join(' ')
    : '';
  return { coverage: best.coverage, fullName, named, residual };
}

function filterResults(results, language) {
  let filtered = results;

  if (language && language !== 'all') {
    const requestedLanguage = normalizeSearchLanguage(language);
    filtered = filtered.filter(book => {
      const bookLanguage = normalizeSearchLanguage(book.language);
      return bookLanguage && bookLanguage === requestedLanguage;
    });
  }

  return filtered;
}

function scoreResults(query, results) {
  const queryLower = query.toLowerCase();
  const queryNorm = normalizeTitle(query);
  const queryWords = queryLower.split(/\s+/).filter(word => word.length > 1);
  const queryTokens = normalizeText(query).split(' ').filter(Boolean);
  const titlesBySource = {};

  for (const result of results) {
    const source = result.source || 'annas';
    if (!titlesBySource[source]) titlesBySource[source] = new Set();
    titlesBySource[source].add(normalizeTitle(result.title));
  }

  return results.map(result => {
    let relevanceScore = 0;
    const titleLower = (result.title || '').toLowerCase();
    const titleNorm = normalizeTitle(result.title);
    const authorLower = (result.author || '').toLowerCase();

    const authorEvidence = queryAuthorEvidence(queryTokens, result.author);
    const mainTitle = mainTitleText(result.title);
    const residualTitleExact = Boolean(authorEvidence.residual) && mainTitle === authorEvidence.residual;
    const titleExact = titleNorm === queryNorm || residualTitleExact;

    if (titleExact) {
      relevanceScore += 200;
    } else if (titleNorm.includes(queryNorm) ||
        (authorEvidence.residual && mainTitle.includes(authorEvidence.residual))) {
      relevanceScore += 150;
    } else if (titleLower.includes(queryLower)) {
      relevanceScore += 100;
    }
    if (boundedQueryTypoEvidence(query, result.title)) relevanceScore += 175;
    else if (boundedQueryTypoEvidence(query, result.author)) relevanceScore += 90;

    // Words that name the author are not title words, so they do not dilute
    // the title-word share.
    const titleQueryWords = authorEvidence.residual
      ? authorEvidence.residual.split(' ').filter(word => word.length > 1)
      : queryWords;
    const titleWords = titleNorm.split(/\s+/);
    const matchingWords = titleQueryWords.filter(queryWord =>
      titleWords.some(titleWord => titleWord === queryWord || titleWord.startsWith(queryWord))
    );
    relevanceScore += Math.round((titleQueryWords.length > 0 ? matchingWords.length / titleQueryWords.length : 0) * 80);

    if (authorEvidence.fullName) relevanceScore += 60;
    else if (authorEvidence.named) relevanceScore += 45;
    else if (authorEvidence.coverage > 0) relevanceScore += Math.round(authorEvidence.coverage * 30);

    if (!titleExact && titleNorm.length > queryNorm.length * 3) relevanceScore -= 10;

    // A subtitle is not a runaway title when the main title is what was asked for.
    const qualityPenalty = searchResultPenalty(result, query, { ignoreLength: titleExact });
    const sourcePenalty = sourceFileQualityPenalty(result);
    relevanceScore -= qualityPenalty.penalty;
    relevanceScore -= editionTitlePenalty(result, { ignoreLength: titleExact });
    relevanceScore -= sourcePenalty.penalty;

    const normalizedTitle = normalizeTitle(result.title);
    const otherSources = Object.entries(titlesBySource).filter(([source]) => source !== result.source);
    if (otherSources.some(([, titles]) => titles.has(normalizedTitle))) relevanceScore += 20;

    if (result.source === 'standardebooks') {
      relevanceScore += 85;
    } else if (result.source === 'gutenberg') {
      relevanceScore += 50;
    } else if (result.source === 'internetarchive') {
      relevanceScore += 25;
    }

    const year = extractYear(result.publisher);
    result._year = year;
    return {
      ...result,
      qualityScore: calculateQualityScore(result),
      relevanceScore,
      searchPenaltyLabels: [...qualityPenalty.labels, ...sourcePenalty.labels],
      _year: year
    };
  });
}

function compareEditions(a, b) {
  const formatOrder = { EPUB: 0, MOBI: 1, AZW3: 1, AZW: 1, PRC: 1, PDF: 9 };
  const formatA = formatOrder[String(a.format || '').toUpperCase()] ?? 3;
  const formatB = formatOrder[String(b.format || '').toUpperCase()] ?? 3;
  if (formatA !== formatB) return formatA - formatB;

  const sourcePenaltyA = sourceFileQualityPenalty(a).penalty;
  const sourcePenaltyB = sourceFileQualityPenalty(b).penalty;
  if (sourcePenaltyA !== sourcePenaltyB) return sourcePenaltyA - sourcePenaltyB;

  const editionPenaltyA = editionTitlePenalty(a);
  const editionPenaltyB = editionTitlePenalty(b);
  if (editionPenaltyA !== editionPenaltyB) return editionPenaltyA - editionPenaltyB;

  const yearA = a._year || 0;
  const yearB = b._year || 0;
  if (yearB !== yearA) return yearB - yearA;
  return parseSizeToBytes(b.size) - parseSizeToBytes(a.size);
}

const OPEN_LIBRARY_IDENTITY_CANDIDATE_LIMIT = 8;

function isHighConfidenceOpenLibrary(identity) {
  return Boolean(identity?.openLibraryWorkKey && ['high', 'medium'].includes(identity.confidence?.level));
}

function openLibraryRelevanceBonus(result, queryIdentity) {
  if (!result.openLibraryWorkKey || !result.metadataConfidence) return 0;

  let bonus = result.metadataConfidence.level === 'high'
    ? 80
    : result.metadataConfidence.level === 'medium'
      ? 45
      : 0;
  if (queryIdentity?.openLibraryWorkKey && result.openLibraryWorkKey === queryIdentity.openLibraryWorkKey) {
    bonus += 220;
  }
  return bonus;
}

function candidateIdentityKey(input) {
  return JSON.stringify([
    input.title || '',
    input.author || '',
    input.language || '',
    input.queryTitle || '',
    input.queryAuthor || ''
  ]);
}

async function enrichWithOpenLibraryIdentity({ query, language, results, resolveOpenLibraryIdentity }) {
  if (typeof resolveOpenLibraryIdentity !== 'function') return results;

  let queryIdentity;
  try {
    queryIdentity = await resolveOpenLibraryIdentity({
      title: query,
      queryTitle: query,
      language
    });
  } catch {
    // Identity lookup is optional search enrichment. Provider results remain
    // usable if Open Library is unavailable.
  }
  const trustedQueryIdentity = isHighConfidenceOpenLibrary(queryIdentity) ? queryIdentity : null;

  const candidates = results
    .slice()
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, OPEN_LIBRARY_IDENTITY_CANDIDATE_LIMIT);
  const identities = new Map();
  const identityRequests = new Map();

  await Promise.all(candidates.map(async result => {
    try {
      const input = {
        title: result.title,
        author: result.author,
        language: result.language || language,
        queryTitle: trustedQueryIdentity?.title,
        queryAuthor: trustedQueryIdentity?.author
      };
      const key = candidateIdentityKey(input);
      if (!identityRequests.has(key)) {
        identityRequests.set(key, Promise.resolve().then(() => resolveOpenLibraryIdentity(input)));
      }
      const identity = await identityRequests.get(key);
      if (isHighConfidenceOpenLibrary(identity)) identities.set(result, identity);
    } catch {
      // A single candidate must not suppress the rest of the search response.
    }
  }));

  return results.map(result => {
    const identity = identities.get(result);
    if (!identity) return result;

    const enriched = {
      ...result,
      openLibraryWorkKey: identity.openLibraryWorkKey,
      openLibraryEditionKey: identity.openLibraryEditionKey,
      openLibraryTitle: identity.title,
      openLibraryAuthor: identity.primaryAuthor || identity.author,
      isbn: identity.isbn,
      metadataConfidence: {
        source: 'openlibrary',
        score: identity.confidence.score,
        level: identity.confidence.level
      },
      openLibraryMatchedFrom: identity.matchedFrom
    };
    return {
      ...enriched,
      relevanceScore: enriched.relevanceScore + openLibraryRelevanceBonus(enriched, trustedQueryIdentity)
    };
  });
}

function emptyResultsResponse(sourceStatus, error, includeResults = false) {
  return {
    works: [],
    totalWorks: 0,
    totalEditions: 0,
    counts: { works: 0, editions: 0 },
    recommended: null,
    alternatives: [],
    ...(includeResults ? { results: [] } : {}),
    sourceStatus,
    error
  };
}

function editionIdentity(edition = {}) {
  if (edition.hash) return `${edition.source || 'unknown'}:${edition.hash}`;
  return `${edition.source || 'unknown'}:${edition.title || ''}:${edition.author || ''}:${edition.format || ''}:${edition.downloadUrl || ''}`;
}

function workCoverBasis(work) {
  const editions = Array.isArray(work?.editions) ? work.editions : [];
  const confidenceRank = { high: 0, medium: 1 };
  return editions.slice().sort((left, right) => {
    const rank = edition => {
      const confidence = confidenceRank[String(edition.metadataConfidence?.level || '').toLowerCase()] ?? 3;
      const hasCatalogIdentity = Boolean(
        edition.openLibraryWorkKey ||
        edition.openLibraryEditionKey ||
        (Array.isArray(edition.isbn) ? edition.isbn.length : edition.isbn)
      );
      return [
        hasCatalogIdentity ? confidence : 4,
        edition.openLibraryWorkKey === work.openLibraryWorkKey ? 0 : 1,
        edition.source === 'standardebooks' || edition.source === 'gutenberg' ? 0 : 1
      ];
    };
    const leftRank = rank(left);
    const rightRank = rank(right);
    return leftRank[0] - rightRank[0] ||
      leftRank[1] - rightRank[1] ||
      leftRank[2] - rightRank[2] ||
      editionIdentity(left).localeCompare(editionIdentity(right));
  })[0];
}

/**
 * Produces the complete, externally visible catalog-search response from raw
 * provider results. `projectEdition` is the route-owned cover adapter and
 * `resolveOpenLibraryIdentity` is the optional catalog-identity adapter.
 */
// Validates the client-supplied search fields before any provider or ranking
// code sees them. A non-string `query` or `language` used to reach
// `.toLowerCase()` / `.toUpperCase()` and fail as a 500. Returns an error
// message, or null when the input is usable.
function catalogSearchInputError({ query, language } = {}) {
  if (typeof query !== 'string' || !query.trim()) return 'Query required';
  if (language !== undefined && language !== null && typeof language !== 'string') {
    return 'language must be a string';
  }
  return null;
}

async function buildCatalogSearchResponse({
  query,
  requestedQuery = query,
  searchCorrection,
  results = [],
  language,
  sourceStatus,
  projectEdition = result => result,
  resolveOpenLibraryIdentity,
  workGroupingMode = process.env.SEARCH_WORK_GROUPING_MODE
}) {
  const inputError = catalogSearchInputError({ query: requestedQuery, language });
  if (inputError) throw Object.assign(new TypeError(inputError), { statusCode: 400 });
  const filteredResults = filterResults(results, language);
  if (filteredResults.length === 0) {
    return emptyResultsResponse(
      sourceStatus,
      language && language !== 'all' ? `No results found in ${language.toUpperCase()}` : 'No results found'
    );
  }

  // A preliminary score bounds external identity work; enriched identities are
  // applied before grouping and final work ranking.
  const scoredResults = scoreResults(query, filteredResults);
  const enrichedResults = await enrichWithOpenLibraryIdentity({
    query,
    language,
    results: scoredResults,
    resolveOpenLibraryIdentity
  });
  const groupingDiagnostics = process.env.SEARCH_GROUP_DEBUG === '1' ? [] : null;
  const rankedWorks = buildSearchWorks(enrichedResults, {
    compareEditions,
    usableEdition: edition => edition.qualityScore >= 2 || String(edition.format).toUpperCase() === 'PDF',
    resolutionMode: workGroupingMode,
    diagnostics: groupingDiagnostics
  });
  if (groupingDiagnostics) {
    console.info(`[search-work-resolution] ${JSON.stringify({
      mode: workGroupingMode === 'exact' ? 'exact' : 'conservative',
      inputCount: enrichedResults.length,
      workCount: rankedWorks.length,
      decisions: groupingDiagnostics
    })}`);
  }

  rankedWorks.sort((a, b) => {
    if (b.bestRelevance !== a.bestRelevance) return b.bestRelevance - a.bestRelevance;
    if (b.qualityScore !== a.qualityScore) return b.qualityScore - a.qualityScore;
    return parseSizeToBytes(b.bestEdition?.size) - parseSizeToBytes(a.bestEdition?.size);
  });

  const acceptableWorks = rankedWorks.filter(work =>
    work.editions.length > 0 && (work.qualityScore >= 2 || String(work.bestEdition?.format).toUpperCase() === 'PDF')
  );
  if (acceptableWorks.length === 0) {
    return emptyResultsResponse(sourceStatus, 'No quality versions found, try different search', true);
  }

  const intentResult = applySearchIntent(query, acceptableWorks);
  const works = intentResult.works.map(work => {
    const basis = workCoverBasis(work) || work.bestEdition;
    const representativeWorkKey = basis?.openLibraryWorkKey || work.openLibraryWorkKey;
    const representativeConfidence = basis?.metadataConfidence;
    const projectedEditions = work.editions.map(edition => {
      const projected = projectEdition(edition);
      return {
        ...projected,
        ...(representativeWorkKey && !projected.openLibraryWorkKey
          ? { openLibraryWorkKey: representativeWorkKey }
          : {}),
        ...(representativeConfidence && !projected.metadataConfidence
          ? { metadataConfidence: representativeConfidence }
          : {})
      };
    });
    const projectedWorkCover = basis
      ? projectEdition({
          ...basis,
          title: work.title || basis.title,
          author: work.author || basis.author,
          openLibraryWorkKey: representativeWorkKey
        })
      : null;
    const coverUrl = projectedWorkCover?.coverUrl || projectedEditions[0]?.coverUrl;
    const bestEdition = coverUrl
      ? { ...projectedEditions[0], coverUrl }
      : projectedEditions[0];
    const editions = [bestEdition, ...projectedEditions.slice(1)];
    return {
      ...work,
      bestEdition,
      editions,
      alternateEditions: editions.slice(1),
      title: work.title || bestEdition.title,
      author: work.author || bestEdition.author,
      coverUrl
    };
  });
  const totalEditions = works.reduce((total, work) => total + work.editionCount, 0);
  const toLegacyResult = work => ({
    ...work.bestEdition,
    workId: work.id,
    workIdentity: work.workIdentity,
    editionCount: work.editionCount,
    otherEditions: work.alternateEditions
  });
  const seenAlternativeIdentities = new Set([editionIdentity(works[0].bestEdition)]);
  const alternatives = [
    ...works[0].alternateEditions,
    ...works.slice(1).map(toLegacyResult)
  ].filter(edition => {
    const identity = editionIdentity(edition);
    if (seenAlternativeIdentities.has(identity)) return false;
    seenAlternativeIdentities.add(identity);
    return true;
  });

  return {
    works,
    totalWorks: works.length,
    totalEditions,
    counts: { works: works.length, editions: totalEditions },
    searchIntent: intentResult.intent,
    recommended: toLegacyResult(works[0]),
    alternatives,
    results: works.flatMap(work => work.editions),
    sourceStatus,
    requestedQuery,
    effectiveQuery: query,
    ...(searchCorrection ? { searchCorrection } : {})
  };
}

module.exports = { buildCatalogSearchResponse, catalogSearchInputError, __test: { normalizeTitle, MAX_NORMALIZED_TITLE_CHARS } };
