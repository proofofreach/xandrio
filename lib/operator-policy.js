const { sourceRightsPolicy } = require('./source-provenance');

const OPERATOR_POLICY_VERSION = 1;

function validAcknowledgedAt(value) {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function operatorPolicyStatus(settings = {}) {
  if (settings?.version === OPERATOR_POLICY_VERSION && 'acknowledged' in settings) {
    const acknowledged = Boolean(settings.acknowledged && validAcknowledgedAt(settings.acknowledgedAt));
    return {
      version: OPERATOR_POLICY_VERSION,
      acknowledged,
      acknowledgedAt: acknowledged ? settings.acknowledgedAt : null,
      unverifiedSourcesEnabled: acknowledged && settings.unverifiedSourcesEnabled === true
    };
  }
  const stored = settings?.operatorPolicy || {};
  const acknowledged = stored.version === OPERATOR_POLICY_VERSION && validAcknowledgedAt(stored.acknowledgedAt);
  return {
    version: OPERATOR_POLICY_VERSION,
    acknowledged,
    acknowledgedAt: acknowledged ? stored.acknowledgedAt : null,
    unverifiedSourcesEnabled: acknowledged && stored.unverifiedSourcesEnabled === true
  };
}

function sourceEnabled(source, settingsOrStatus = {}) {
  const policy = sourceRightsPolicy(source);
  if (!policy.requiresOperatorAcknowledgement) return true;
  return operatorPolicyStatus(settingsOrStatus).unverifiedSourcesEnabled;
}

function decorateSourceDescriptors(descriptors, settingsOrStatus = {}) {
  const status = operatorPolicyStatus(settingsOrStatus);
  return (Array.isArray(descriptors) ? descriptors : []).map(descriptor => {
    const requiresAcknowledgement = Boolean(descriptor.requiresOperatorAcknowledgement);
    const acknowledged = !requiresAcknowledgement || status.acknowledged;
    return {
      ...descriptor,
      requiresAcknowledgement,
      acknowledged,
      enabled: descriptor.configured !== false && (!requiresAcknowledgement || status.unverifiedSourcesEnabled)
    };
  });
}

function blockedSourceIds(sources, settingsOrStatus = {}) {
  return [...new Set((Array.isArray(sources) ? sources : [])
    .filter(source => typeof source === 'string' && !sourceEnabled(source, settingsOrStatus)))];
}

function filterEnabledAlternatives(alternatives, settingsOrStatus = {}) {
  return (Array.isArray(alternatives) ? alternatives : [])
    .filter(alternative => sourceEnabled(alternative?.source || 'annas', settingsOrStatus));
}

module.exports = {
  OPERATOR_POLICY_VERSION,
  operatorPolicyStatus,
  sourceEnabled,
  decorateSourceDescriptors,
  blockedSourceIds,
  filterEnabledAlternatives
};
