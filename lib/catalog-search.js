const { buildSearchWorks, applySearchIntent } = require('./search-work-groups');
const { boundedQueryTypoEvidence } = require('./search-fuzzy-matching');
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

function normalizeTitle(title) {
  return (title || '')
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

function searchResultPenalty(result, query) {
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

  if (title.length > Math.max(80, String(query || '').length * 2.5)) {
    penalty += 35;
    labels.push('runaway-title');
  }

  return { penalty, labels };
}

function editionTitlePenalty(result) {
  const title = String(result?.title || '');
  let penalty = 0;
  if (/\b(centennial|anniversary|classics?|amazonclassics|barnes\s*&\s*noble|edition|annotated|illustrated|dubliners)\b/i.test(title)) {
    penalty += 40;
  }
  if (title.length > 70) penalty += 15;
  return penalty;
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

  const ebookFormats = new Set(['EPUB', 'MOBI', 'AZW', 'AZW3', 'PRC']);
  const hasEbookCandidates = filtered.some(result => ebookFormats.has(String(result.format || '').toUpperCase()));
  if (hasEbookCandidates) {
    filtered = filtered.filter(result => ebookFormats.has(String(result.format || '').toUpperCase()));
  }

  return filtered;
}

function scoreResults(query, results) {
  const queryLower = query.toLowerCase();
  const queryNorm = normalizeTitle(query);
  const queryWords = queryLower.split(/\s+/).filter(word => word.length > 1);
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

    if (titleNorm === queryNorm) {
      relevanceScore += 200;
    } else if (titleNorm.includes(queryNorm)) {
      relevanceScore += 150;
    } else if (titleLower.includes(queryLower)) {
      relevanceScore += 100;
    }
    if (boundedQueryTypoEvidence(query, result.title)) relevanceScore += 175;
    else if (boundedQueryTypoEvidence(query, result.author)) relevanceScore += 90;

    const titleWords = titleNorm.split(/\s+/);
    const matchingWords = queryWords.filter(queryWord =>
      titleWords.some(titleWord => titleWord === queryWord || titleWord.startsWith(queryWord))
    );
    relevanceScore += Math.round((queryWords.length > 0 ? matchingWords.length / queryWords.length : 0) * 80);

    const authorWords = authorLower.split(/[\s,]+/);
    if (queryWords.some(queryWord => authorWords.some(authorWord => authorWord === queryWord))) {
      relevanceScore += 40;
    }

    if (titleNorm.length > queryNorm.length * 3) relevanceScore -= 10;

    const qualityPenalty = searchResultPenalty(result, query);
    const sourcePenalty = sourceFileQualityPenalty(result);
    relevanceScore -= qualityPenalty.penalty;
    relevanceScore -= editionTitlePenalty(result);
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

  await Promise.all(candidates.map(async result => {
    try {
      const identity = await resolveOpenLibraryIdentity({
        title: result.title,
        author: result.author,
        language: result.language || language,
        queryTitle: trustedQueryIdentity?.title,
        queryAuthor: trustedQueryIdentity?.author
      });
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

/**
 * Produces the complete, externally visible catalog-search response from raw
 * provider results. `projectEdition` is the route-owned cover adapter and
 * `resolveOpenLibraryIdentity` is the optional catalog-identity adapter.
 */
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
    const editions = work.editions.map(projectEdition);
    const bestEdition = editions[0];
    return {
      ...work,
      bestEdition,
      editions,
      alternateEditions: editions.slice(1),
      title: work.title || bestEdition.title,
      author: work.author || bestEdition.author,
      coverUrl: bestEdition.coverUrl
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

module.exports = { buildCatalogSearchResponse };
