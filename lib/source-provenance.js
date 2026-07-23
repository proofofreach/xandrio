const SOURCE_RIGHTS_POLICIES = Object.freeze({
  annas: Object.freeze({ rightsStatus: 'unverified', requiresOperatorAcknowledgement: true }),
  zlibrary: Object.freeze({ rightsStatus: 'unverified', requiresOperatorAcknowledgement: true }),
  gutenberg: Object.freeze({ rightsStatus: 'provider-metadata', requiresOperatorAcknowledgement: false }),
  internetarchive: Object.freeze({ rightsStatus: 'unverified', requiresOperatorAcknowledgement: true }),
  standardebooks: Object.freeze({ rightsStatus: 'provider-metadata', requiresOperatorAcknowledgement: false }),
  upload: Object.freeze({ rightsStatus: 'operator-supplied', requiresOperatorAcknowledgement: false })
});

const OPERATOR_CONFIGURED_POLICY = Object.freeze({
  rightsStatus: 'operator-configured',
  requiresOperatorAcknowledgement: true
});

function sourceRightsPolicy(source) {
  return SOURCE_RIGHTS_POLICIES[source] || OPERATOR_CONFIGURED_POLICY;
}

function cleanText(value, maxLength = 240) {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, maxLength) : undefined;
}

function safeSourceUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    if (url.username || url.password) return undefined;
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

function sourceItemId(source, selection = {}) {
  const candidates = {
    internetarchive: [selection.iaIdentifier, selection.hash],
    gutenberg: [selection.gutenbergId, selection.hash],
    zlibrary: [selection.zlibId, selection.hash],
    annas: [selection.hash],
    standardebooks: [selection.opdsId, selection.hash]
  }[source] || [selection.opdsId, selection.hash];
  return candidates.find(value => typeof value === 'string' && value.trim());
}

function sourceProvenanceFromSelection(selection = {}) {
  const provider = cleanText(selection.source, 80) || 'annas';
  return {
    itemId: cleanText(sourceItemId(provider, selection), 256),
    sourceUrl: safeSourceUrl(selection.sourceUrl || selection.url),
    reportedLicense: cleanText(selection.reportedLicense || selection.license || selection.licence),
    reportedRights: cleanText(selection.reportedRights || selection.rights, 500)
  };
}

function buildSourceProvenance({ provider, acquiredAt, originalFilename, details = {} }) {
  const source = provider || 'upload';
  const itemId = cleanText(details.itemId, 256);
  const sourceUrl = safeSourceUrl(details.sourceUrl);
  const reportedLicense = cleanText(details.reportedLicense);
  const reportedRights = cleanText(details.reportedRights, 500);
  return {
    provider: source,
    rightsStatus: sourceRightsPolicy(source).rightsStatus,
    acquiredAt,
    ...(source === 'upload' && originalFilename ? { originalFilename: cleanText(originalFilename, 500) } : {}),
    ...(itemId ? { itemId } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(reportedLicense ? { reportedLicense } : {}),
    ...(reportedRights ? { reportedRights } : {})
  };
}

module.exports = {
  SOURCE_RIGHTS_POLICIES,
  sourceRightsPolicy,
  buildSourceProvenance,
  sourceProvenanceFromSelection,
  safeSourceUrl
};
