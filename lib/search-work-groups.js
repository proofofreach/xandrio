const crypto = require('crypto');
const { resolveSearchWorkClusters } = require('./search-work-resolution');
const { boundedQueryTypoEvidence } = require('./search-fuzzy-matching');
const {
  normalizeText,
  contributorIdentities,
  primaryCreatorIdentity,
  primaryCreatorDisplay,
  canonicalWorkTitle,
  fallbackWorkIdentity
} = require('./search-work-normalization');

function normalizeAuthorIdentity(author) {
  // Kept as the public normalizer for callers that need the work's primary
  // creator. Full contributor matching is exposed through contributorIdentities.
  return primaryCreatorIdentity(author);
}

function stableWorkId(identity) {
  return `work-${crypto.createHash('sha1').update(String(identity)).digest('hex').slice(0, 20)}`;
}

function uniqueEditions(editions) {
  const seen = new Set();
  return editions.filter(edition => {
    const key = edition.hash
      ? `${edition.source || 'unknown'}:${edition.hash}`
      : `${edition.source || 'unknown'}:${edition.title || ''}:${edition.author || ''}:${edition.format || ''}:${edition.downloadUrl || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildSearchWorks(results = [], options = {}) {
  const compareEditions = options.compareEditions || (() => 0);
  const usableEdition = options.usableEdition || (() => true);
  return resolveSearchWorkClusters(results, {
    mode: options.resolutionMode,
    diagnostics: options.diagnostics
  }).map(group => {
    const editions = uniqueEditions(group.editions).sort(compareEditions);
    const usableEditions = editions.filter(usableEdition);
    const selectableEditions = usableEditions.length ? usableEditions : editions;
    const bestEdition = selectableEditions[0];
    const workTitle = group.displayTitle || bestEdition?.title || editions[0]?.title || 'Untitled';
    const workAuthor = group.displayAuthor || primaryCreatorDisplay(bestEdition?.author || editions[0]?.author) || 'Unknown';
    const contributors = [...new Set(editions.flatMap(edition => contributorIdentities(edition.author)))];
    const sources = [...new Set(selectableEditions.map(edition => String(edition.source || 'unknown')))].sort();
    return {
      id: stableWorkId(group.workIdentity),
      workIdentity: group.workIdentity,
      openLibraryWorkKey: group.openLibraryWorkKey || undefined,
      title: workTitle,
      author: workAuthor,
      primaryCreator: primaryCreatorIdentity(bestEdition?.author || editions[0]?.author),
      contributorIdentities: contributors,
      bestEdition,
      editions: selectableEditions,
      alternateEditions: selectableEditions.slice(1),
      editionCount: selectableEditions.length,
      versionCount: selectableEditions.length,
      sourceCount: sources.length,
      sources,
      resolution: group.resolution,
      totalEditionCount: editions.length,
      bestRelevance: Math.max(...editions.map(edition => Number(edition.relevanceScore) || 0)),
      qualityScore: Number(bestEdition?.qualityScore) || 0
    };
  });
}

const TITLE_LIKE_AUTHOR_WORDS = new Set([
  'a', 'an', 'and', 'for', 'from', 'in', 'of', 'on', 'the', 'to', 'with'
]);

function looksLikePersonalCreatorName(value) {
  const tokens = canonicalWorkTitle(value).split(' ').filter(Boolean);
  return tokens.length >= 2 && tokens.length <= 5 &&
    tokens.every(token => /^[a-z]+$/u.test(token) && !TITLE_LIKE_AUTHOR_WORDS.has(token));
}

function looksLikeFilenameTitle(value) {
  return /\.(?:azw3?|docx?|epub|html?|mobi|pdf|rtf|txt|xhtml)$/iu.test(String(value || '').trim());
}

function looksLikeSwappedTitleAndAuthor(authorIdentity, work) {
  const authorTokens = String(authorIdentity || '').split(' ').filter(Boolean);
  const authorLooksTitleLike = authorTokens.some(token => /\d/u.test(token)) ||
    authorTokens.length > 5 ||
    authorTokens.some(token => TITLE_LIKE_AUTHOR_WORDS.has(token));
  return (authorLooksTitleLike && looksLikePersonalCreatorName(work.title)) ||
    (looksLikeFilenameTitle(work.title) && looksLikePersonalCreatorName(authorIdentity));
}

function authorIntentForQuery(query, works = []) {
  const queryIdentity = normalizeAuthorIdentity(query);
  const queryTokens = queryIdentity.split(' ').filter(token => token.length > 1);
  if (queryTokens.length === 0) return null;

  const candidates = new Map();
  for (const work of works) {
    const contributors = work.contributorIdentities?.length
      ? work.contributorIdentities
      : contributorIdentities(work.bestEdition?.author || work.author);
    for (const authorIdentity of contributors) {
      if (!authorIdentity || authorIdentity === 'unknown' ||
          looksLikeSwappedTitleAndAuthor(authorIdentity, work)) continue;
      const authorTokens = new Set(authorIdentity.split(' '));
      const matches = queryTokens.filter(token => authorTokens.has(token));
      if (matches.length !== queryTokens.length) continue;
      const exact = authorIdentity === queryIdentity;
      // A single common given name ("John") is not enough to turn a title
      // search into an author search. Surnames and one-word pen names are.
      if (!exact && queryTokens.length === 1 && queryTokens[0].length < 5) continue;
      const current = candidates.get(authorIdentity);
      if (!current || exact || Number(work.bestRelevance) > Number(current.work.bestRelevance)) {
        candidates.set(authorIdentity, { authorIdentity, author: String(query || '').trim(), exact, work });
      }
    }
  }

  const exactCandidate = [...candidates.values()]
    .sort((a, b) => Number(b.exact) - Number(a.exact) || Number(b.work.bestRelevance) - Number(a.work.bestRelevance))[0];
  if (exactCandidate) return exactCandidate;

  const fuzzyCandidates = new Map();
  for (const work of works) {
    const contributors = work.contributorIdentities?.length
      ? work.contributorIdentities
      : contributorIdentities(work.bestEdition?.author || work.author);
    for (const authorIdentity of contributors) {
      if (!authorIdentity || authorIdentity === 'unknown' ||
          looksLikeSwappedTitleAndAuthor(authorIdentity, work) ||
          !boundedQueryTypoEvidence(queryIdentity, authorIdentity)) continue;
      const current = fuzzyCandidates.get(authorIdentity);
      if (!current || Number(work.bestRelevance) > Number(current.work.bestRelevance)) {
        fuzzyCandidates.set(authorIdentity, {
          authorIdentity,
          author: work.author || authorIdentity,
          exact: false,
          fuzzy: true,
          work
        });
      }
    }
  }
  return fuzzyCandidates.size === 1 ? [...fuzzyCandidates.values()][0] : null;
}

function applySearchIntent(query, works = []) {
  const authorIntent = authorIntentForQuery(query, works);
  if (authorIntent) {
    const authored = [];
    const related = [];
    for (const work of works) {
      const contributors = work.contributorIdentities?.length
        ? work.contributorIdentities
        : contributorIdentities(work.bestEdition?.author || work.author);
      const enriched = {
        ...work,
        searchGroup: contributors.includes(authorIntent.authorIdentity) ? 'authored' : 'related',
        isBestMatch: false
      };
      (enriched.searchGroup === 'authored' ? authored : related).push(enriched);
    }
    return {
      intent: { kind: 'author', author: authorIntent.author, ...(authorIntent.fuzzy ? { match: 'fuzzy' } : {}) },
      works: [...authored, ...related]
    };
  }

  const queryTitle = canonicalWorkTitle(query);
  let bestMatchAssigned = false;
  const hasExactTitle = Boolean(queryTitle) && works.some(work => canonicalWorkTitle(work.title) === queryTitle);
  const hasFuzzyTitle = !hasExactTitle && Boolean(queryTitle) && works.some(work =>
    boundedQueryTypoEvidence(queryTitle, canonicalWorkTitle(work.title))
  );
  return {
    intent: { kind: hasExactTitle || hasFuzzyTitle ? 'title' : 'general', ...(hasFuzzyTitle ? { match: 'fuzzy' } : {}) },
    works: works.map(work => {
      const titleMatches = hasExactTitle
        ? canonicalWorkTitle(work.title) === queryTitle
        : hasFuzzyTitle && boundedQueryTypoEvidence(queryTitle, canonicalWorkTitle(work.title));
      const isBestMatch = Boolean(titleMatches) && !bestMatchAssigned;
      if (isBestMatch) bestMatchAssigned = true;
      return { ...work, searchGroup: 'results', isBestMatch };
    })
  };
}

module.exports = {
  normalizeText,
  normalizeAuthorIdentity,
  canonicalWorkTitle,
  fallbackWorkIdentity,
  buildSearchWorks,
  authorIntentForQuery,
  applySearchIntent
};
