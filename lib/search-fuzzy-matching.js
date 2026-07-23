const { normalizeText } = require('./search-work-normalization');

function damerauLevenshtein(leftValue, rightValue) {
  const left = String(leftValue || '');
  const right = String(rightValue || '');
  const rows = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
  for (let index = 0; index <= left.length; index++) rows[index][0] = index;
  for (let index = 0; index <= right.length; index++) rows[0][index] = index;

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      const substitution = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      rows[leftIndex][rightIndex] = Math.min(
        rows[leftIndex - 1][rightIndex] + 1,
        rows[leftIndex][rightIndex - 1] + 1,
        rows[leftIndex - 1][rightIndex - 1] + substitution
      );
      if (leftIndex > 1 && rightIndex > 1 &&
          left[leftIndex - 1] === right[rightIndex - 2] &&
          left[leftIndex - 2] === right[rightIndex - 1]) {
        rows[leftIndex][rightIndex] = Math.min(
          rows[leftIndex][rightIndex],
          rows[leftIndex - 2][rightIndex - 2] + 1
        );
      }
    }
  }
  return rows[left.length][right.length];
}

function adjacentTransposition(left, right) {
  if (left.length !== right.length) return false;
  const differences = [];
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) differences.push(index);
  }
  return differences.length === 2 && differences[1] === differences[0] + 1 &&
    left[differences[0]] === right[differences[1]] &&
    left[differences[1]] === right[differences[0]];
}

function boundedTokenTypo(left, right) {
  if (!left || !right || left === right) return null;
  const shortest = Math.min(left.length, right.length);
  const longest = Math.max(left.length, right.length);
  if (shortest < 5 || longest - shortest > 1) return null;
  if (damerauLevenshtein(left, right) !== 1) return null;

  const transposition = adjacentTransposition(left, right);
  const insertionOrDeletion = left.length !== right.length;
  const substitution = left.length === right.length && !transposition;
  if (substitution && longest < 7) return null;
  return {
    left,
    right,
    distance: 1,
    edit: transposition ? 'transposition' : insertionOrDeletion ? 'insertion-deletion' : 'substitution'
  };
}

function boundedTitleTypoEvidence(leftValue, rightValue) {
  const left = normalizeText(leftValue).split(' ').filter(Boolean);
  const right = normalizeText(rightValue).split(' ').filter(Boolean);
  if (!left.length || left.length !== right.length) return null;

  const differences = [];
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) differences.push(index);
  }
  if (differences.length !== 1) return null;
  const index = differences[0];
  const token = boundedTokenTypo(left[index], right[index]);
  return token ? { ...token, tokenIndex: index } : null;
}

function titleTypoCandidateKeys(value) {
  const tokens = normalizeText(value).split(' ').filter(Boolean);
  const keys = new Set();
  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
    const token = tokens[tokenIndex];
    if (token.length < 5) continue;
    const context = tokens.map((value, index) => index === tokenIndex ? '*' : value).join(' ');
    keys.add(`${tokens.length}:${tokenIndex}:${context}:${token}`);
    for (let characterIndex = 0; characterIndex < token.length; characterIndex++) {
      const deletion = token.slice(0, characterIndex) + token.slice(characterIndex + 1);
      keys.add(`${tokens.length}:${tokenIndex}:${context}:${deletion}`);
    }
  }
  return [...keys].sort();
}

function providerDamageTitleVariants(value) {
  const tokens = normalizeText(value).split(' ')
    .filter(token => token && !['a', 'an', 'the', 'of'].includes(token));
  if (tokens.length < 4) return [];
  const variants = [{ title: tokens.join(' '), removedModifier: '' }];
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].length < 5 || !tokens[index].endsWith('ly')) continue;
    variants.push({
      title: tokens.filter((_, tokenIndex) => tokenIndex !== index).join(' '),
      removedModifier: tokens[index]
    });
  }
  return variants;
}

function boundedProviderTitleDamageEvidence(leftValue, rightValue) {
  const candidates = [];
  for (const left of providerDamageTitleVariants(leftValue)) {
    for (const right of providerDamageTitleVariants(rightValue)) {
      if (Number(Boolean(left.removedModifier)) + Number(Boolean(right.removedModifier)) !== 1) continue;
      const typo = boundedTitleTypoEvidence(left.title, right.title);
      if (!typo || typo.edit === 'substitution') continue;
      candidates.push({
        ...typo,
        removedModifier: left.removedModifier || right.removedModifier,
        leftTitle: left.title,
        rightTitle: right.title
      });
    }
  }
  return candidates.sort((a, b) =>
    a.leftTitle.localeCompare(b.leftTitle) || a.rightTitle.localeCompare(b.rightTitle)
  )[0] || null;
}

function providerTitleDamageCandidateKeys(value) {
  const keys = new Set();
  for (const variant of providerDamageTitleVariants(value)) {
    for (const key of titleTypoCandidateKeys(variant.title)) keys.add(key);
  }
  return [...keys].sort();
}

function correctionCandidate(queryTokens, displayValue, kind) {
  const targetTokens = normalizeText(displayValue).split(' ').filter(Boolean);
  if (!targetTokens.length || queryTokens.length > targetTokens.length) return null;
  const used = new Set();
  const unmatched = [];
  for (let queryIndex = 0; queryIndex < queryTokens.length; queryIndex++) {
    const exactIndex = targetTokens.findIndex((token, targetIndex) =>
      !used.has(targetIndex) && token === queryTokens[queryIndex]
    );
    if (exactIndex >= 0) used.add(exactIndex);
    else unmatched.push(queryIndex);
  }
  if (unmatched.length !== 1) return null;

  const queryIndex = unmatched[0];
  const matches = targetTokens
    .map((token, targetIndex) => ({ token, targetIndex, evidence: used.has(targetIndex) ? null : boundedTokenTypo(queryTokens[queryIndex], token) }))
    .filter(candidate => candidate.evidence);
  if (matches.length !== 1) return null;
  const match = matches[0];
  const correctedTokens = queryTokens.slice();
  correctedTokens[queryIndex] = match.token;
  return {
    kind,
    displayValue,
    correctedTokens,
    extras: targetTokens.length - queryTokens.length,
    evidence: match.evidence
  };
}

function boundedQueryTypoEvidence(queryValue, candidateValue) {
  const queryTokens = normalizeText(queryValue).split(' ').filter(Boolean);
  if (!queryTokens.length) return null;
  const candidate = correctionCandidate(queryTokens, candidateValue, 'candidate');
  return candidate ? {
    edit: candidate.evidence.edit,
    correctedTokens: candidate.correctedTokens,
    extraCandidateTokens: candidate.extras
  } : null;
}

function validatedSearchCorrection(queryValue, identity = {}) {
  if (!identity.openLibraryWorkKey) return null;
  const originalQuery = String(queryValue || '').replace(/\s+/g, ' ').trim();
  const queryTokens = normalizeText(originalQuery).split(' ').filter(Boolean);
  if (!queryTokens.length) return null;

  const title = String(identity.title || '').trim();
  const author = String(identity.author || '').trim();
  const candidates = [
    title && correctionCandidate(queryTokens, title, 'title'),
    author && correctionCandidate(queryTokens, author, 'author'),
    title && author && correctionCandidate(queryTokens, `${title} ${author}`, 'title-author')
  ].filter(Boolean).sort((left, right) =>
    left.extras - right.extras ||
    ['title', 'author', 'title-author'].indexOf(left.kind) - ['title', 'author', 'title-author'].indexOf(right.kind)
  );
  const candidate = candidates[0];
  if (!candidate) return null;

  const correctedQuery = candidate.extras === 0 && candidate.kind !== 'title-author'
    ? candidate.displayValue
    : candidate.correctedTokens.join(' ');
  if (normalizeText(correctedQuery) === normalizeText(originalQuery)) return null;
  return {
    originalQuery,
    correctedQuery,
    kind: candidate.kind,
    source: 'openlibrary',
    confidence: 'high',
    evidence: ['single-token-edit', candidate.evidence.edit, 'catalog-authority']
  };
}

module.exports = {
  boundedTitleTypoEvidence,
  titleTypoCandidateKeys,
  boundedProviderTitleDamageEvidence,
  providerTitleDamageCandidateKeys,
  boundedQueryTypoEvidence,
  validatedSearchCorrection
};
