const crypto = require('crypto');
const {
  canonicalWorkTitle,
  fallbackWorkIdentity,
  normalizedOpenLibraryWorkKey,
  primaryCreatorIdentity,
  primaryCreatorDisplay,
  creatorIdentityProfiles,
  creatorProfilesCompatible,
  hasEditionTitleLabel,
  normalizeLanguage,
  normalizePublisher,
  normalizedIsbns,
  contentQualifiers
} = require('./search-work-normalization');
const {
  boundedTitleTypoEvidence,
  titleTypoCandidateKeys,
  boundedProviderTitleDamageEvidence,
  providerTitleDamageCandidateKeys
} = require('./search-fuzzy-matching');

const METHOD_PRIORITY = {
  'openlibrary-work': 0,
  'duplicate-authority-work': 1,
  'authority-bibliographic-match': 1,
  'canonical-title-author': 1,
  'metadata-title-author': 2,
  'subtitle-title-author': 2,
  'anchored-subtitle-title-author': 2,
  'bounded-title-typo': 3,
  'bounded-creator-typo': 3,
  'bounded-title-damage': 4,
  'metadata-publisher-title-author': 4,
  'confirmed-publisher-alias': 4
};

const CONSERVATIVE_ONLY_METHODS = new Set([
  'bounded-title-typo',
  'bounded-creator-typo',
  'bounded-title-damage',
  'metadata-publisher-title-author',
  'confirmed-publisher-alias'
]);
const BIBLIOGRAPHIC_FORM_PARENS = /\s*[\[(]\s*(?:an?\s+)?(?:novel|novella|short\s+stories|story\s+collection|stories|poems?|poetry|plays?|essays?|memoir|autobiography)\s*[\])]/giu;
const SMALL_TITLE_NUMBERS = new Map([
  ['one', '1'], ['two', '2'], ['three', '3'], ['four', '4'], ['five', '5'],
  ['six', '6'], ['seven', '7'], ['eight', '8'], ['nine', '9'], ['ten', '10']
]);

function setIntersection(left, right) {
  return [...left].filter(value => right.has(value));
}

function editionIdentity(edition = {}) {
  if (edition.hash) return `${edition.source || 'unknown'}:${edition.hash}`;
  return `${edition.source || 'unknown'}:${edition.title || ''}:${edition.author || ''}:${edition.format || ''}:${edition.downloadUrl || edition.url || ''}`;
}

function phraseContains(haystack, needle) {
  return Boolean(haystack && needle && ` ${haystack} `.includes(` ${needle} `));
}

// The alias-extraction regexes below backtrack polynomially on pathological
// inputs; bounding the scanned text keeps them O(1) in practice. Titles past
// this length carry no additional alias information.
const MAX_TITLE_SCAN_LENGTH = 400;
function boundedTitleText(value) {
  return String(value || '').slice(0, MAX_TITLE_SCAN_LENGTH);
}

function publisherParentheticalTitle(title, publisher) {
  const value = boundedTitleText(title);
  const match = value.match(/\s*(?:\(([^()]*)\)|\[([^\[\]]*)\])\s*$/u);
  if (!match) return '';
  const label = normalizePublisher(match[1] ?? match[2]);
  const normalizedPublisher = normalizePublisher(publisher);
  if (!label || !normalizedPublisher) return '';
  const shorter = label.length <= normalizedPublisher.length ? label : normalizedPublisher;
  const significantWords = shorter.split(' ')
    .filter(word => word !== 'and' && word.length >= 3);
  if (significantWords.length < 2) return '';
  if (!phraseContains(label, normalizedPublisher) && !phraseContains(normalizedPublisher, label)) return '';
  return value.slice(0, match.index).trim();
}

function articleNeutralMetadataTitle(title) {
  const value = boundedTitleText(title);
  const withoutArticle = value.replace(/^(?:a|an|the)\s+/, '');
  if (withoutArticle === value || withoutArticle.split(' ').length < 7) return '';
  return /\b(?:and|plus)\b/.test(withoutArticle) ? withoutArticle : '';
}

function numberedTitleForm(title) {
  const tokens = canonicalWorkTitle(title).split(' ').filter(Boolean);
  if (tokens.length < 5) return '';
  let changed = false;
  const normalized = tokens.map(token => {
    const number = SMALL_TITLE_NUMBERS.get(token);
    if (!number) return token;
    changed = true;
    return number;
  });
  if (['a', 'an', 'the'].includes(normalized[0]) && /^\d+$/u.test(normalized[1])) {
    normalized.shift();
    changed = true;
  }
  return changed ? normalized.join(' ') : '';
}

function finalizeTitleAliases(aliases) {
  const numberedAliases = aliases.map(alias => numberedTitleForm(alias.title))
    .filter(Boolean)
    .map(title => ({ title, kind: 'numbered-title-form' }));
  return [...aliases, ...numberedAliases].filter((alias, index, list) =>
    alias.title && list.findIndex(candidate => candidate.title === alias.title && candidate.kind === alias.kind) === index
  );
}

function publisherTitleAliases(title, publisher, author) {
  const canonical = canonicalWorkTitle(title);
  const normalizedPublisher = normalizePublisher(publisher);
  const aliases = [{ title: canonical, kind: 'exact' }];
  const metadataAliases = [];
  const scanTitle = boundedTitleText(title);
  const withoutContentForms = scanTitle.replace(BIBLIOGRAPHIC_FORM_PARENS, ' ');
  if (withoutContentForms !== scanTitle) {
    metadataAliases.push({ title: canonicalWorkTitle(withoutContentForms), kind: 'bibliographic-form' });
  }
  const withoutPublisherLabel = publisherParentheticalTitle(title, publisher);
  if (withoutPublisherLabel) {
    metadataAliases.push({ title: canonicalWorkTitle(withoutPublisherLabel), kind: 'publisher-parenthetical' });
  }
  aliases.push(...metadataAliases);
  for (const alias of metadataAliases) {
    const articleNeutral = articleNeutralMetadataTitle(alias.title);
    if (articleNeutral) aliases.push({ title: articleNeutral, kind: 'article-neutral-metadata' });
  }
  const creatorProfiles = creatorIdentityProfiles(author);
  const embeddedCreatorMatches = value => creatorProfilesCompatible(
    creatorIdentityProfiles(value),
    creatorProfiles
  );
  const byline = scanTitle.match(/^(.+?)\s+by\s+(.+)$/iu);
  if (byline && embeddedCreatorMatches(byline[2])) {
    aliases.push({ title: canonicalWorkTitle(byline[1]), kind: 'creator-byline' });
  }
  const creatorSuffix = scanTitle.match(/^(.+?)[,;]\s*([^,;]+)$/u);
  if (creatorSuffix && embeddedCreatorMatches(creatorSuffix[2])) {
    aliases.push({ title: canonicalWorkTitle(creatorSuffix[1]), kind: 'creator-suffix' });
  }
  const filename = scanTitle.match(/^(.+?)_+([^_]+)$/u);
  if (filename && embeddedCreatorMatches(filename[1])) {
    aliases.push({ title: canonicalWorkTitle(filename[2]), kind: 'creator-prefix' });
  }
  for (const profile of creatorProfiles.filter(value => !String(value).startsWith('@'))) {
    if (!canonical.startsWith(`${profile} `)) continue;
    const baseTitle = canonical.slice(profile.length).trim();
    if (baseTitle) aliases.push({ title: baseTitle, kind: 'creator-prefix' });
  }
  const subtitle = scanTitle.match(/^(.+?)\s*:\s*\S/u);
  if (subtitle) {
    const baseTitle = canonicalWorkTitle(subtitle[1]);
    if (baseTitle && baseTitle !== canonical) aliases.push({ title: baseTitle, kind: 'subtitle-base' });
  }
  if (!canonical || !normalizedPublisher) return finalizeTitleAliases(aliases);

  const fullPrefix = canonical.startsWith(`${normalizedPublisher} `)
    ? canonical.slice(normalizedPublisher.length).trim()
    : '';
  const fullSuffix = canonical.endsWith(` ${normalizedPublisher}`)
    ? canonical.slice(0, -(normalizedPublisher.length + 1)).trim()
    : '';
  for (const value of [fullPrefix, fullSuffix]) {
    if (value) aliases.push({ title: value, kind: 'publisher-full' });
  }

  const publisherWords = normalizedPublisher.split(' ').filter(Boolean);
  const head = publisherWords[0] || '';
  if (publisherWords.length > 1 && head.length >= 5) {
    const headPrefix = canonical.startsWith(`${head} `) ? canonical.slice(head.length).trim() : '';
    const headSuffix = canonical.endsWith(` ${head}`) ? canonical.slice(0, -(head.length + 1)).trim() : '';
    for (const value of [headPrefix, headSuffix]) {
      if (value) aliases.push({ title: value, kind: 'publisher-head' });
    }
  }

  return finalizeTitleAliases(aliases);
}

function factsFor(edition) {
  const confidence = String(edition.metadataConfidence?.level || '').toLowerCase();
  const openLibraryWorkKey = normalizedOpenLibraryWorkKey(edition.openLibraryWorkKey);
  return {
    edition,
    editionIdentity: editionIdentity(edition),
    title: canonicalWorkTitle(edition.title),
    authorityTitle: confidence === 'medium' || confidence === 'high'
      ? canonicalWorkTitle(edition.openLibraryTitle)
      : '',
    authorityDisplayTitle: confidence === 'medium' || confidence === 'high'
      ? String(edition.openLibraryTitle || '').trim()
      : '',
    authorityCreator: confidence === 'medium' || confidence === 'high'
      ? primaryCreatorIdentity(edition.openLibraryAuthor)
      : '',
    authorityDisplayAuthor: confidence === 'medium' || confidence === 'high'
      ? String(edition.openLibraryAuthor || '').trim()
      : '',
    titleAliases: publisherTitleAliases(edition.title, edition.publisher, edition.author),
    hasEditionTitleLabel: hasEditionTitleLabel(edition.title),
    creator: primaryCreatorIdentity(edition.author),
    creatorDisplay: primaryCreatorDisplay(edition.author),
    creatorProfiles: creatorIdentityProfiles(edition.author),
    publisher: normalizePublisher(edition.publisher),
    year: Number.isInteger(Number(edition._year)) && Number(edition._year) > 0 ? Number(edition._year) : null,
    language: normalizeLanguage(edition.language),
    isbns: new Set(normalizedIsbns(edition.isbn)),
    openLibraryWorkKey: confidence === 'medium' || confidence === 'high' ? openLibraryWorkKey : '',
    qualifiers: contentQualifiers(edition.title)
  };
}

function aggregateGroup(baseIdentity, facts) {
  return {
    baseIdentity,
    facts: facts.slice().sort((a, b) => a.editionIdentity.localeCompare(b.editionIdentity)),
    titles: new Set(facts.map(fact => fact.title).filter(Boolean)),
    aliases: facts.flatMap(fact => fact.titleAliases),
    creators: new Set(facts.map(fact => fact.creator).filter(Boolean)),
    creatorProfiles: new Set(facts.flatMap(fact => fact.creatorProfiles)),
    authorityTitles: new Set(facts.map(fact => fact.authorityTitle).filter(Boolean)),
    authorityCreators: new Set(facts.map(fact => fact.authorityCreator).filter(Boolean)),
    publishers: new Set(facts.map(fact => fact.publisher).filter(Boolean)),
    years: new Set(facts.map(fact => fact.year).filter(Boolean)),
    languages: new Set(facts.map(fact => fact.language).filter(Boolean)),
    isbns: new Set(facts.flatMap(fact => [...fact.isbns])),
    openLibraryKeys: new Set(facts.map(fact => fact.openLibraryWorkKey).filter(Boolean)),
    hasEditionTitleLabel: facts.some(fact => fact.hasEditionTitleLabel),
    sources: new Set(facts.map(fact => String(fact.edition.source || 'unknown'))),
    volumes: new Set(facts.map(fact => fact.qualifiers.volume).filter(Boolean)),
    hasUnnumbered: facts.some(fact => !fact.qualifiers.volume),
    collectionScopes: new Set(facts.map(fact => fact.qualifiers.collectionScope).filter(scope => scope !== 'unknown')),
    derivativeStates: new Set(facts.map(fact => Boolean(fact.qualifiers.derivative))),
    adaptedStates: new Set(facts.map(fact => Boolean(fact.qualifiers.adapted)))
  };
}

function groupsHaveCompatibleCreators(left, right) {
  return creatorProfilesCompatible(left.creatorProfiles, right.creatorProfiles);
}

function hasIndependentCrossSourceSupport(left, right) {
  if (left.sources.size === 0 || right.sources.size === 0) return false;
  return setIntersection(left.sources, right.sources).length === 0 ||
    (left.sources.size >= 2 && right.sources.size >= 2);
}

function sharedTrustedAuthorityIdentity(left, right) {
  if (left.authorityTitles.size !== 1 || right.authorityTitles.size !== 1 ||
      left.authorityCreators.size !== 1 || right.authorityCreators.size !== 1) return null;
  const title = [...left.authorityTitles][0];
  const creator = [...left.authorityCreators][0];
  return title === [...right.authorityTitles][0] && creator === [...right.authorityCreators][0]
    ? { title, creator }
    : null;
}

function initialGroups(results) {
  const facts = results.map(factsFor);
  const fallbackToOpenLibrary = new Map();
  for (const fact of facts) {
    const fallback = fallbackWorkIdentity(fact.edition);
    if (!fact.openLibraryWorkKey) continue;
    if (!fallbackToOpenLibrary.has(fallback)) fallbackToOpenLibrary.set(fallback, new Set());
    fallbackToOpenLibrary.get(fallback).add(fact.openLibraryWorkKey);
  }

  const grouped = new Map();
  for (const fact of facts) {
    const fallback = fallbackWorkIdentity(fact.edition);
    const knownKeys = fallbackToOpenLibrary.get(fallback);
    const bridgedKey = knownKeys?.size === 1 ? [...knownKeys][0] : '';
    const languageIdentity = fact.language || 'unknown';
    const semanticPartition = [
      `creator:${fact.creator || 'unknown'}`,
      `volume:${fact.qualifiers.volume || 'whole'}`,
      `scope:${fact.qualifiers.collectionScope}`,
      `derivative:${Number(fact.qualifiers.derivative)}`,
      `adapted:${Number(fact.qualifiers.adapted)}`
    ].join('|');
    const identity = fact.openLibraryWorkKey || bridgedKey
      ? `openlibrary:${fact.openLibraryWorkKey || bridgedKey}|lang:${languageIdentity}|${semanticPartition}`
      : fact.creator
        ? `catalog:${fallback}|lang:${languageIdentity}`
        : `unidentified:${fact.editionIdentity}|lang:${languageIdentity}`;
    if (!grouped.has(identity)) grouped.set(identity, []);
    grouped.get(identity).push(fact);
  }

  return [...grouped.entries()]
    .map(([identity, groupFacts]) => aggregateGroup(identity, groupFacts))
    .sort((a, b) => a.baseIdentity.localeCompare(b.baseIdentity));
}

function hardConflict(left, right, options = {}) {
  if (!options.ignoreCreator && left.creators.size && right.creators.size && !groupsHaveCompatibleCreators(left, right)) {
    return 'creator-conflict';
  }
  if (left.languages.size && right.languages.size && setIntersection(left.languages, right.languages).length === 0) {
    return 'language-conflict';
  }
  if (left.openLibraryKeys.size && right.openLibraryKeys.size && setIntersection(left.openLibraryKeys, right.openLibraryKeys).length === 0) {
    const hasTrustedAuthorityIdentity = left.authorityTitles.size || right.authorityTitles.size ||
      left.authorityCreators.size || right.authorityCreators.size;
    const recognizedEditionAlias = !hasTrustedAuthorityIdentity &&
      (left.hasEditionTitleLabel || right.hasEditionTitleLabel) &&
      setIntersection(left.titles, right.titles).length > 0;
    if (!recognizedEditionAlias && !sharedTrustedAuthorityIdentity(left, right)) return 'openlibrary-conflict';
  }
  if ((left.volumes.size || right.volumes.size) &&
      (left.hasUnnumbered !== right.hasUnnumbered || setIntersection(left.volumes, right.volumes).length === 0)) {
    return 'volume-conflict';
  }
  const leftCollection = left.collectionScopes.has('collection');
  const rightCollection = right.collectionScopes.has('collection');
  if (left.collectionScopes.size && right.collectionScopes.size && leftCollection !== rightCollection) {
    return 'collection-scope-conflict';
  }
  if (left.derivativeStates.size === 1 && right.derivativeStates.size === 1 &&
      [...left.derivativeStates][0] !== [...right.derivativeStates][0]) {
    return 'derivative-conflict';
  }
  if (left.adaptedStates.size === 1 && right.adaptedStates.size === 1 &&
      [...left.adaptedStates][0] !== [...right.adaptedStates][0]) {
    return 'adaptation-conflict';
  }
  return '';
}

function subtitleEvidence(left, right) {
  const candidates = [];
  for (const alias of left.aliases.filter(candidate => candidate.kind === 'subtitle-base')) {
    if (right.titles.has(alias.title)) candidates.push(alias.title);
  }
  for (const alias of right.aliases.filter(candidate => candidate.kind === 'subtitle-base')) {
    if (left.titles.has(alias.title)) candidates.push(alias.title);
  }
  const title = candidates.sort()[0];
  return title ? {
    title,
    method: 'subtitle-title-author',
    confidence: 'exact',
    evidence: ['primary-title', 'compatible-creator']
  } : null;
}

function subtitleExtensionEvidence(left, right) {
  const leftBases = new Set(left.aliases
    .filter(candidate => candidate.kind === 'subtitle-base')
    .map(candidate => candidate.title));
  const rightBases = new Set(right.aliases
    .filter(candidate => candidate.kind === 'subtitle-base')
    .map(candidate => candidate.title));
  const sharedBases = setIntersection(leftBases, rightBases);
  if (!sharedBases.length) return null;

  const candidates = [];
  for (const base of sharedBases) {
    for (const leftTitle of left.titles) {
      for (const rightTitle of right.titles) {
        if (!leftTitle.startsWith(`${base} `) || !rightTitle.startsWith(`${base} `)) continue;
        const shorter = leftTitle.length <= rightTitle.length ? leftTitle : rightTitle;
        const longer = leftTitle.length <= rightTitle.length ? rightTitle : leftTitle;
        if (longer.startsWith(`${shorter} `)) candidates.push(shorter);
      }
    }
  }
  const title = candidates.sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
  return title ? {
    title,
    method: 'subtitle-title-author',
    confidence: 'exact',
    evidence: ['primary-title', 'subtitle-extension', 'compatible-creator']
  } : null;
}

function metadataTitleEvidence(left, right) {
  const metadataKinds = new Set([
    'creator-byline',
    'creator-prefix',
    'creator-suffix',
    'numbered-title-form',
    'bibliographic-form',
    'publisher-parenthetical',
    'article-neutral-metadata'
  ]);
  const conservativeKinds = new Set(['publisher-parenthetical', 'article-neutral-metadata']);
  const compatibleKinds = new Set(['exact', ...metadataKinds]);
  const candidates = [];
  for (const leftAlias of left.aliases) {
    for (const rightAlias of right.aliases) {
      if (!leftAlias.title || leftAlias.title !== rightAlias.title) continue;
      if (!compatibleKinds.has(leftAlias.kind) || !compatibleKinds.has(rightAlias.kind)) continue;
      if (!metadataKinds.has(leftAlias.kind) && !metadataKinds.has(rightAlias.kind)) continue;
      candidates.push({
        title: leftAlias.title,
        conservative: conservativeKinds.has(leftAlias.kind) || conservativeKinds.has(rightAlias.kind)
      });
    }
  }
  const candidate = candidates.sort((a, b) =>
    Number(a.conservative) - Number(b.conservative) || a.title.localeCompare(b.title)
  )[0];
  return candidate ? {
    title: candidate.title,
    method: candidate.conservative ? 'metadata-publisher-title-author' : 'metadata-title-author',
    confidence: candidate.conservative ? 'corroborated' : 'exact',
    evidence: ['creator-conditioned-title', 'compatible-creator']
  } : null;
}

function aliasEvidence(left, right) {
  const sharedPublishers = setIntersection(left.publishers, right.publishers);
  if (sharedPublishers.length === 0) return null;
  const sharedIsbns = setIntersection(left.isbns, right.isbns);
  if (!hasIndependentCrossSourceSupport(left, right) && sharedIsbns.length === 0) return null;

  const candidates = [];
  for (const leftAlias of left.aliases) {
    for (const rightAlias of right.aliases) {
      // Subtitle bases have their own stricter rule: one side must actually
      // use the unsuffixed title. Shared publisher metadata must not merge two
      // distinct sibling subtitles.
      if (leftAlias.kind === 'subtitle-base' || rightAlias.kind === 'subtitle-base') continue;
      if (!leftAlias.title || leftAlias.title !== rightAlias.title) continue;
      if (leftAlias.kind === 'exact' && rightAlias.kind === 'exact') continue;
      const usesHead = leftAlias.kind === 'publisher-head' || rightAlias.kind === 'publisher-head';
      if (usesHead && sharedIsbns.length === 0) continue;
      candidates.push({
        title: leftAlias.title,
        method: 'confirmed-publisher-alias',
        confidence: 'corroborated',
        evidence: usesHead ? ['publisher-head', 'shared-isbn'] : ['publisher-label']
      });
    }
  }
  return candidates.sort((a, b) => a.title.localeCompare(b.title))[0] || null;
}

function fuzzyTitleEvidence(left, right) {
  if (!hasIndependentCrossSourceSupport(left, right)) return null;
  const candidates = [];
  for (const leftTitle of left.titles) {
    for (const rightTitle of right.titles) {
      const typo = boundedTitleTypoEvidence(leftTitle, rightTitle);
      if (!typo) continue;
      candidates.push({ leftTitle, rightTitle, typo });
    }
  }
  const candidate = candidates.sort((a, b) =>
    a.leftTitle.localeCompare(b.leftTitle) || a.rightTitle.localeCompare(b.rightTitle)
  )[0];
  return candidate ? {
    title: candidate.leftTitle,
    method: 'bounded-title-typo',
    confidence: 'bounded-fuzzy',
    evidence: ['single-token-edit', candidate.typo.edit, 'compatible-creator', 'cross-source']
  } : null;
}

function damagedTitleEvidence(left, right) {
  const allowedKinds = new Set(['exact', 'subtitle-base', 'numbered-title-form']);
  const candidates = [];
  for (const leftAlias of left.aliases) {
    if (!allowedKinds.has(leftAlias.kind)) continue;
    for (const rightAlias of right.aliases) {
      if (!allowedKinds.has(rightAlias.kind)) continue;
      const damage = boundedProviderTitleDamageEvidence(leftAlias.title, rightAlias.title);
      if (!damage) continue;
      candidates.push({ leftAlias, rightAlias, damage });
    }
  }
  const candidate = candidates.sort((a, b) =>
    a.leftAlias.title.localeCompare(b.leftAlias.title) ||
    a.rightAlias.title.localeCompare(b.rightAlias.title)
  )[0];
  return candidate ? {
    title: candidate.leftAlias.kind === 'subtitle-base'
      ? candidate.leftAlias.title
      : candidate.rightAlias.kind === 'subtitle-base'
        ? candidate.rightAlias.title
        : candidate.leftAlias.title,
    method: 'bounded-title-damage',
    confidence: 'bounded-fuzzy',
    evidence: [
      'function-word-normalization',
      `omitted-modifier:${candidate.damage.removedModifier}`,
      'single-token-edit',
      candidate.damage.edit,
      'compatible-creator'
    ]
  } : null;
}

function fuzzyCreatorEvidence(left, right) {
  if (!hasIndependentCrossSourceSupport(left, right)) return null;
  const sharedTitles = setIntersection(left.titles, right.titles);
  if (!sharedTitles.length) return null;
  const candidates = [];
  for (const leftCreator of left.creatorProfiles) {
    for (const rightCreator of right.creatorProfiles) {
      if (String(leftCreator).startsWith('@') || String(rightCreator).startsWith('@')) continue;
      const typo = boundedTitleTypoEvidence(leftCreator, rightCreator);
      if (!typo || typo.edit === 'substitution') continue;
      candidates.push({ leftCreator, rightCreator, typo });
    }
  }
  const candidate = candidates.sort((a, b) =>
    a.leftCreator.localeCompare(b.leftCreator) || a.rightCreator.localeCompare(b.rightCreator)
  )[0];
  return candidate ? {
    title: sharedTitles.sort()[0],
    method: 'bounded-creator-typo',
    confidence: 'bounded-fuzzy',
    evidence: ['canonical-title', 'single-token-edit', candidate.typo.edit, 'cross-source']
  } : null;
}

function creatorPrefixedUnknownEvidence(left, right) {
  const orientations = [
    { unknown: left, known: right },
    { unknown: right, known: left }
  ];
  for (const { unknown, known } of orientations) {
    if (unknown.creators.size || !known.creators.size) continue;
    const knownTitles = new Set([
      ...known.titles,
      ...known.aliases.map(alias => alias.title).filter(Boolean)
    ]);
    for (const title of [...unknown.titles].sort()) {
      for (const profile of [...known.creatorProfiles]
        .filter(value => !String(value).startsWith('@'))
        .sort((a, b) => b.length - a.length || a.localeCompare(b))) {
        if (!title.startsWith(`${profile} `)) continue;
        const baseTitle = title.slice(profile.length).trim();
        if (!knownTitles.has(baseTitle)) continue;
        return {
          title: baseTitle,
          method: 'metadata-title-author',
          confidence: 'exact',
          evidence: ['title-embedded-creator', 'canonical-title']
        };
      }
    }
  }
  return null;
}

function authorityBibliographicEvidence(left, right) {
  if (hardConflict(left, right, { ignoreCreator: true })) return null;
  const orientations = [
    { authority: left, provider: right },
    { authority: right, provider: left }
  ];
  for (const { authority, provider } of orientations) {
    if (authority.openLibraryKeys.size !== 1 || authority.authorityTitles.size !== 1 ||
        authority.authorityCreators.size !== 1) continue;
    const title = [...authority.authorityTitles][0];
    const sharedPublishers = setIntersection(authority.publishers, provider.publishers);
    const sharedYears = setIntersection(authority.years, provider.years);
    if (!provider.titles.has(title) || !sharedPublishers.length || !sharedYears.length) continue;
    return {
      title,
      method: 'authority-bibliographic-match',
      confidence: 'corroborated',
      evidence: ['trusted-title', 'exact-publisher', 'publication-year']
    };
  }
  return null;
}

function matchGroups(left, right) {
  const creatorTypo = fuzzyCreatorEvidence(left, right);
  const authorityBibliographic = authorityBibliographicEvidence(left, right);
  const conflict = hardConflict(left, right);
  if (conflict && !(conflict === 'creator-conflict' && (creatorTypo || authorityBibliographic))) {
    return { matched: false, conflict };
  }

  const sharedOpenLibrary = setIntersection(left.openLibraryKeys, right.openLibraryKeys);
  if (sharedOpenLibrary.length) {
    return {
      matched: true,
      title: setIntersection(left.titles, right.titles)[0] || '',
      method: 'openlibrary-work',
      confidence: 'authoritative',
      evidence: ['openlibrary-work']
    };
  }
  const duplicateAuthority = sharedTrustedAuthorityIdentity(left, right);
  if (duplicateAuthority && left.openLibraryKeys.size && right.openLibraryKeys.size) {
    return {
      matched: true,
      title: duplicateAuthority.title,
      method: 'duplicate-authority-work',
      confidence: 'corroborated',
      evidence: ['conflicting-authority-keys', 'trusted-title', 'trusted-creator']
    };
  }
  if (authorityBibliographic) return { matched: true, ...authorityBibliographic };

  const sharedCreators = setIntersection(left.creators, right.creators);
  const compatibleCreators = sharedCreators.length > 0 || groupsHaveCompatibleCreators(left, right);
  const sharedTitles = setIntersection(left.titles, right.titles);
  if (compatibleCreators && sharedTitles.length) {
    return {
      matched: true,
      title: sharedTitles.sort()[0],
      method: 'canonical-title-author',
      confidence: 'exact',
      evidence: ['canonical-title', sharedCreators.length ? 'primary-creator' : 'compatible-creator']
    };
  }
  if (creatorTypo) return { matched: true, ...creatorTypo };

  const creatorPrefixedUnknown = creatorPrefixedUnknownEvidence(left, right);
  if (creatorPrefixedUnknown) return { matched: true, ...creatorPrefixedUnknown };
  if (!compatibleCreators) return { matched: false, conflict: 'insufficient-creator-evidence' };
  const metadataTitle = metadataTitleEvidence(left, right);
  if (metadataTitle) return { matched: true, ...metadataTitle };
  const subtitle = subtitleEvidence(left, right);
  if (subtitle) return { matched: true, ...subtitle };
  const subtitleExtension = subtitleExtensionEvidence(left, right);
  if (subtitleExtension) return { matched: true, ...subtitleExtension };
  const damaged = damagedTitleEvidence(left, right);
  if (damaged) return { matched: true, ...damaged };
  const fuzzy = fuzzyTitleEvidence(left, right);
  if (fuzzy) return { matched: true, ...fuzzy };
  const alias = aliasEvidence(left, right);
  return alias ? { matched: true, ...alias } : { matched: false, conflict: 'insufficient-title-evidence' };
}

function anchoredSiblingSubtitleEvidence(left, right, clusterGroups) {
  if (hardConflict(left, right) || !groupsHaveCompatibleCreators(left, right)) return null;
  const leftBases = new Set(left.aliases
    .filter(candidate => candidate.kind === 'subtitle-base')
    .map(candidate => candidate.title));
  const rightBases = new Set(right.aliases
    .filter(candidate => candidate.kind === 'subtitle-base')
    .map(candidate => candidate.title));
  const sharedBases = setIntersection(leftBases, rightBases)
    .filter(base => base.split(' ').filter(Boolean).length >= 5)
    .filter(base => !left.titles.has(base) && !right.titles.has(base));

  for (const base of sharedBases.sort()) {
    const anchor = clusterGroups.find(group =>
      group.titles.has(base) &&
      matchGroups(group, left).matched &&
      matchGroups(group, right).matched
    );
    if (!anchor) continue;
    return {
      matched: true,
      title: base,
      method: 'anchored-subtitle-title-author',
      confidence: 'corroborated',
      evidence: ['unsuffixed-title-anchor', 'compatible-creator']
    };
  }
  return null;
}

function anchoredCreatorPrefixedUnknownEvidence(left, right, clusterGroups) {
  if (left.creators.size || right.creators.size || !setIntersection(left.titles, right.titles).length) return null;
  const anchor = clusterGroups.find(group =>
    group.creators.size &&
    creatorPrefixedUnknownEvidence(left, group) &&
    creatorPrefixedUnknownEvidence(right, group)
  );
  if (!anchor) return null;
  return {
    matched: true,
    title: creatorPrefixedUnknownEvidence(left, anchor).title,
    method: 'metadata-title-author',
    confidence: 'exact',
    evidence: ['known-creator-anchor', 'title-embedded-creator']
  };
}

function anchoredTrustedAuthorityEvidence(left, right, clusterGroups) {
  const anchor = clusterGroups.find(group => {
    if (!group.openLibraryKeys.size || !group.authorityTitles.size || !group.authorityCreators.size) return false;
    return matchGroups(group, left).matched && matchGroups(group, right).matched;
  });
  if (!anchor) return null;
  return {
    matched: true,
    title: [...anchor.authorityTitles].sort()[0] || [...anchor.titles].sort()[0] || '',
    method: 'authority-bibliographic-match',
    confidence: 'corroborated',
    evidence: ['trusted-work-anchor', 'independent-pair-evidence']
  };
}

function clusterPairMatch(left, right, clusterGroups, resolutionMode) {
  const direct = matchGroups(left, right);
  if (direct.matched && !(resolutionMode === 'exact' && CONSERVATIVE_ONLY_METHODS.has(direct.method))) {
    return direct;
  }
  return anchoredTrustedAuthorityEvidence(left, right, clusterGroups) ||
    anchoredSiblingSubtitleEvidence(left, right, clusterGroups) ||
    anchoredCreatorPrefixedUnknownEvidence(left, right, clusterGroups) ||
    direct;
}

function commonResolvedTitle(groups) {
  const titlesByGroup = groups.map(group => new Set(group.aliases.map(alias => alias.title).filter(Boolean)));
  const common = [...(titlesByGroup[0] || [])].filter(title => titlesByGroup.every(titles => titles.has(title)));
  if (common.length) {
    return common.sort((a, b) => {
      const exactA = groups.filter(group => group.titles.has(a)).length;
      const exactB = groups.filter(group => group.titles.has(b)).length;
      return exactB - exactA || a.length - b.length || a.localeCompare(b);
    })[0];
  }
  return [...groups[0].titles].sort()[0] || 'untitled';
}

function chooseDisplayEdition(facts, resolvedTitle) {
  return facts.slice().sort((a, b) => {
    const aExact = Number(a.title === resolvedTitle);
    const bExact = Number(b.title === resolvedTitle);
    return bExact - aExact ||
      String(a.edition.title || '').length - String(b.edition.title || '').length ||
      a.editionIdentity.localeCompare(b.editionIdentity);
  })[0];
}

function fallbackProfile(fact, resolvedLanguage) {
  const qualifiers = fact.qualifiers;
  return [
    fact.language || resolvedLanguage || 'unknown',
    qualifiers.volume || 'whole',
    qualifiers.derivative ? 'derivative' : 'original',
    qualifiers.adapted ? 'adapted' : 'unaltered',
    qualifiers.abridgement,
    qualifiers.textualVersion || 'standard-text'
  ].join('|');
}

function stableFallbackGroupId(workIdentity, profile) {
  return `fallback-${crypto.createHash('sha1').update(`${workIdentity}|${profile}`).digest('hex').slice(0, 16)}`;
}

function diagnosticId(identity) {
  return crypto.createHash('sha1').update(String(identity)).digest('hex').slice(0, 12);
}

function diagnosticSources(left, right) {
  return [...new Set([...left.sources, ...right.sources])].sort();
}

function candidatePairsFor(groups) {
  const buckets = new Map();
  const add = (key, index) => {
    if (!key) return;
    if (!buckets.has(key)) buckets.set(key, new Set());
    buckets.get(key).add(index);
  };

  groups.forEach((group, index) => {
    for (const key of group.openLibraryKeys) add(`openlibrary:${key}`, index);
    for (const title of group.authorityTitles) {
      for (const creator of group.authorityCreators) add(`authority:${creator}:${title}`, index);
    }
    for (const alias of group.aliases) add(`title-alias:${alias.title}`, index);
    for (const alias of group.aliases) {
      for (const key of providerTitleDamageCandidateKeys(alias.title)) add(`title-damage:${key}`, index);
    }
    for (const title of group.titles) {
      for (const key of titleTypoCandidateKeys(title)) add(`title-typo:${key}`, index);
    }
    for (const creator of group.creators) {
      for (const title of group.titles) add(`exact:${creator}:${title}`, index);
      for (const publisher of group.publishers) {
        for (const alias of group.aliases) add(`alias:${creator}:${publisher}:${alias.title}`, index);
      }
    }
    for (const profile of group.creatorProfiles) {
      if (String(profile).startsWith('@')) continue;
      for (const alias of group.aliases) add(`embedded-creator:${profile}:${alias.title}`, index);
    }
    if (!group.creators.size) {
      for (const title of group.titles) {
        const tokens = title.split(' ').filter(Boolean);
        for (let split = 1; split < Math.min(tokens.length, 6); split++) {
          add(`embedded-creator:${tokens.slice(0, split).join(' ')}:${tokens.slice(split).join(' ')}`, index);
        }
      }
    }
  });

  const pairKeys = new Set();
  for (const indexes of buckets.values()) {
    const sorted = [...indexes].sort((a, b) => a - b);
    for (let left = 0; left < sorted.length; left++) {
      for (let right = left + 1; right < sorted.length; right++) {
        pairKeys.add(`${sorted[left]}:${sorted[right]}`);
      }
    }
  }
  return [...pairKeys]
    .map(key => key.split(':').map(Number))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

function resolveSearchWorkClusters(results = [], options = {}) {
  const resolutionMode = options.mode === 'exact' ? 'exact' : 'conservative';
  const diagnostics = Array.isArray(options.diagnostics) ? options.diagnostics : null;
  const groups = initialGroups(results);
  const candidates = [];
  for (const [left, right] of candidatePairsFor(groups)) {
    const match = matchGroups(groups[left], groups[right]);
    if (match.matched && !(resolutionMode === 'exact' && CONSERVATIVE_ONLY_METHODS.has(match.method))) {
      candidates.push({ left, right, match });
    } else if (diagnostics) {
      diagnostics.push({
        type: 'rejected',
        left: diagnosticId(groups[left].baseIdentity),
        right: diagnosticId(groups[right].baseIdentity),
        sources: diagnosticSources(groups[left], groups[right]),
        reason: resolutionMode === 'exact' && CONSERVATIVE_ONLY_METHODS.has(match.method)
          ? 'exact-mode'
          : match.conflict || 'insufficient-evidence'
      });
    }
  }
  candidates.sort((a, b) =>
    METHOD_PRIORITY[a.match.method] - METHOD_PRIORITY[b.match.method] ||
    groups[a.left].baseIdentity.localeCompare(groups[b.left].baseIdentity) ||
    groups[a.right].baseIdentity.localeCompare(groups[b.right].baseIdentity)
  );

  const clusters = groups.map((_, index) => new Set([index]));
  const clusterFor = index => clusters.find(cluster => cluster.has(index));
  for (const candidate of candidates) {
    const leftCluster = clusterFor(candidate.left);
    const rightCluster = clusterFor(candidate.right);
    if (!leftCluster || !rightCluster || leftCluster === rightCluster) continue;
    const combinedGroups = [...leftCluster, ...rightCluster].map(index => groups[index]);
    const compatible = [...leftCluster].every(leftIndex =>
      [...rightCluster].every(rightIndex => {
        const match = clusterPairMatch(groups[leftIndex], groups[rightIndex], combinedGroups, resolutionMode);
        return match.matched && !(resolutionMode === 'exact' && CONSERVATIVE_ONLY_METHODS.has(match.method));
      })
    );
    if (!compatible) continue;
    for (const index of rightCluster) leftCluster.add(index);
    clusters.splice(clusters.indexOf(rightCluster), 1);
    diagnostics?.push({
      type: 'merged',
      left: diagnosticId(groups[candidate.left].baseIdentity),
      right: diagnosticId(groups[candidate.right].baseIdentity),
      sources: diagnosticSources(groups[candidate.left], groups[candidate.right]),
      method: candidate.match.method
    });
  }

  return clusters.map(clusterIndexes => {
    const clusterGroups = [...clusterIndexes].map(index => groups[index]);
    const facts = clusterGroups.flatMap(group => group.facts)
      .sort((a, b) => a.editionIdentity.localeCompare(b.editionIdentity));
    const authorityTitles = new Set(facts.map(fact => fact.authorityTitle).filter(Boolean));
    const resolvedTitle = authorityTitles.size === 1
      ? [...authorityTitles][0]
      : commonResolvedTitle(clusterGroups);
    const displayFact = chooseDisplayEdition(facts, resolvedTitle);
    const authorityDisplayTitle = facts
      .filter(fact => fact.authorityTitle === resolvedTitle && fact.authorityDisplayTitle)
      .map(fact => fact.authorityDisplayTitle)
      .sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
    const authorityCreators = new Set(facts.map(fact => fact.authorityCreator).filter(Boolean));
    const resolvedCreator = authorityCreators.size === 1
      ? [...authorityCreators][0]
      : displayFact?.creator || facts.find(fact => fact.creator)?.creator || 'unknown';
    const authorityDisplayAuthor = facts
      .filter(fact => fact.authorityCreator === resolvedCreator && fact.authorityDisplayAuthor)
      .map(fact => fact.authorityDisplayAuthor)
      .sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
    const openLibraryKeys = new Set(facts.map(fact => fact.openLibraryWorkKey).filter(Boolean));
    const language = [...new Set(facts.map(fact => fact.language).filter(Boolean))].sort()[0] || '';
    const resolvedVolume = [...new Set(facts.map(fact => fact.qualifiers.volume).filter(Boolean))].sort()[0] || '';
    const resolvedCollectionScope = facts.some(fact => fact.qualifiers.collectionScope === 'collection')
      ? 'collection'
      : 'individual';
    const resolvedForm = facts.some(fact => fact.qualifiers.derivative)
      ? 'derivative'
      : facts.some(fact => fact.qualifiers.adapted)
        ? 'adapted'
        : 'original';
    const creator = resolvedCreator;
    const pairMatches = [];
    for (let left = 0; left < clusterGroups.length; left++) {
      for (let right = left + 1; right < clusterGroups.length; right++) {
        pairMatches.push(clusterPairMatch(clusterGroups[left], clusterGroups[right], clusterGroups, resolutionMode));
      }
    }
    const weakest = pairMatches.sort((a, b) => METHOD_PRIORITY[b.method] - METHOD_PRIORITY[a.method])[0];
    const method = weakest?.method || (openLibraryKeys.size ? 'openlibrary-work' : 'canonical-title-author');
    const confidence = weakest?.confidence || (openLibraryKeys.size ? 'authoritative' : 'exact');
    const unidentifiedSuffix = creator === 'unknown'
      ? `|listing:${crypto.createHash('sha1').update(facts.map(fact => fact.editionIdentity).join('|')).digest('hex').slice(0, 12)}`
      : '';
    const workIdentity = openLibraryKeys.size === 1
      ? `openlibrary:${[...openLibraryKeys][0]}${language ? `|lang:${language}` : ''}|creator:${creator || 'unknown'}${resolvedVolume ? `|volume:${resolvedVolume}` : ''}${resolvedCollectionScope === 'collection' ? '|scope:collection' : ''}${resolvedForm !== 'original' ? `|form:${resolvedForm}` : ''}`
      : `catalog:${resolvedTitle}|${creator || 'unknown'}${language ? `|lang:${language}` : ''}${unidentifiedSuffix}`;
    return {
      workIdentity,
      resolvedTitle,
      displayTitle: authorityDisplayTitle || displayFact?.edition.title || 'Untitled',
      displayAuthor: authorityDisplayAuthor || displayFact?.creatorDisplay || 'Unknown',
      openLibraryWorkKey: openLibraryKeys.size === 1 ? [...openLibraryKeys][0] : undefined,
      resolution: { method, confidence },
      editions: facts.map(fact => ({
        ...fact.edition,
        fallbackGroupId: stableFallbackGroupId(workIdentity, fallbackProfile(fact, language))
      }))
    };
  }).sort((a, b) => a.workIdentity.localeCompare(b.workIdentity));
}

function fallbackCompatibility(selected, candidate) {
  const leftFact = factsFor(selected || {});
  const rightFact = factsFor(candidate || {});
  const left = aggregateGroup(`selected:${leftFact.editionIdentity}`, [leftFact]);
  const right = aggregateGroup(`candidate:${rightFact.editionIdentity}`, [rightFact]);
  const match = matchGroups(left, right);
  if (!match.matched) return { safe: false, reason: match.conflict || 'different-work' };
  if (match.method === 'bounded-title-damage') {
    return { safe: false, reason: 'bounded-title-damage' };
  }

  const leftQualifiers = leftFact.qualifiers;
  const rightQualifiers = rightFact.qualifiers;
  if (leftQualifiers.abridgement !== rightQualifiers.abridgement) {
    return { safe: false, reason: 'abridgement-conflict' };
  }
  if (leftQualifiers.textualVersion !== rightQualifiers.textualVersion &&
      (leftQualifiers.textualVersion || rightQualifiers.textualVersion)) {
    return { safe: false, reason: 'textual-version-conflict' };
  }
  return { safe: true, reason: match.method };
}

module.exports = {
  resolveSearchWorkClusters,
  fallbackCompatibility
};
