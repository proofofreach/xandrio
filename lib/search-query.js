const { validatedSearchCorrection } = require('./search-fuzzy-matching');
const { normalizeLanguage } = require('./search-work-normalization');

function hasSuccessfulSource(sourceStatus = {}) {
  const statuses = Object.values(sourceStatus || {});
  return statuses.length === 0 || statuses.some(status => status?.ok === true);
}

function correctionMatchesLanguage(identity, requestedLanguage) {
  const requested = normalizeLanguage(requestedLanguage);
  const rawCandidate = String(identity?.language || '').trim().toLowerCase().replace(/^\/languages\//, '');
  if (['mul', 'und', 'zxx'].includes(rawCandidate)) return true;
  const candidate = normalizeLanguage(identity?.language);
  return !requested || !candidate || requested === candidate;
}

/**
 * Searches the selected providers once. A zero-result search may make one
 * catalog-authority lookup and one corrected retry when a single bounded typo
 * is unambiguous. Provider failures and ambiguous corrections are left intact.
 */
async function searchCatalogQuery({ query, context = {}, search, resolveCorrection }) {
  if (typeof search !== 'function') throw new TypeError('search must be a function');
  const originalQuery = String(query || '').replace(/\s+/g, ' ').trim();
  const original = await search(originalQuery, context);
  const originalResults = Array.isArray(original?.results) ? original.results : [];
  const base = { ...original, results: originalResults, effectiveQuery: originalQuery };
  if (originalResults.length > 0 || typeof resolveCorrection !== 'function' ||
      !hasSuccessfulSource(original?.sourceStatus)) {
    return base;
  }

  let identity;
  try {
    identity = await resolveCorrection({ query: originalQuery, language: context.language });
  } catch {
    return base;
  }
  if (!correctionMatchesLanguage(identity, context.language)) return base;
  const searchCorrection = validatedSearchCorrection(originalQuery, identity);
  if (!searchCorrection) return base;

  let retried;
  try {
    retried = await search(searchCorrection.correctedQuery, context);
  } catch {
    return base;
  }
  const retriedResults = Array.isArray(retried?.results) ? retried.results : [];
  if (retriedResults.length === 0) return base;
  return {
    ...retried,
    results: retriedResults,
    effectiveQuery: searchCorrection.correctedQuery,
    searchCorrection
  };
}

module.exports = { searchCatalogQuery };
