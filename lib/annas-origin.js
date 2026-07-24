'use strict';

const dns = require('dns').promises;
const { assertPublicTarget } = require('./remote-fetch');

const DEFAULT_ANNAS_ORIGIN = 'https://annas-archive.gl';
const LEGACY_ANNAS_ORIGINS = new Set(['https://annas-archive.li']);

function parseOrigin(value) {
  const raw = String(value || DEFAULT_ANNAS_ORIGIN).trim();
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new Error('Anna’s Archive base URL is invalid');
  }
  if (url.protocol !== 'https:' || url.username || url.password ||
      (url.port && url.port !== '443') || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Anna’s Archive base URL must be a bare public HTTPS origin');
  }
  return url.origin;
}

function allowedAnnasOrigins(value = process.env.ANNAS_ALLOWED_ORIGINS) {
  const origins = new Set([DEFAULT_ANNAS_ORIGIN]);
  for (const candidate of String(value || '').split(',')) {
    if (!candidate.trim()) continue;
    origins.add(parseOrigin(candidate));
  }
  return origins;
}

function normalizeAnnasOrigin(value, options = {}) {
  const parsed = parseOrigin(value);
  const origin = LEGACY_ANNAS_ORIGINS.has(parsed) ? DEFAULT_ANNAS_ORIGIN : parsed;
  const allowed = allowedAnnasOrigins(options.allowedOrigins);
  if (!allowed.has(origin)) {
    throw new Error('Anna’s Archive base URL is not in ANNAS_ALLOWED_ORIGINS');
  }
  return origin;
}

async function validateAnnasOrigin(value, options = {}) {
  const origin = normalizeAnnasOrigin(value, options);
  try {
    await assertPublicTarget(
      new URL(origin),
      options.lookupImpl || dns.lookup,
      Number(options.timeoutMs || 5000)
    );
  } catch {
    throw new Error('Anna’s Archive base URL must resolve only to public addresses');
  }
  return origin;
}

module.exports = {
  DEFAULT_ANNAS_ORIGIN,
  allowedAnnasOrigins,
  normalizeAnnasOrigin,
  validateAnnasOrigin
};
