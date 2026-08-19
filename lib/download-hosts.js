'use strict';

/**
 * Binds a provider download to the provider's own hosts.
 *
 * `POST /api/download` takes both the provider name and the URL to fetch from
 * the client. The provider name selects which download function runs and is the
 * only field the operator's unverified-source policy inspects; the URL is what
 * actually gets fetched. Nothing tied the two together, so a client could name a
 * curated, pre-acknowledged catalog (Standard Ebooks, Project Gutenberg) and
 * point the URL at any host it liked -- bypassing the acknowledgement gate and
 * stamping a false `rightsStatus: 'provider-metadata'` provenance record on
 * whatever came back.
 *
 * The check belongs at the download sinks rather than at the route: every sink
 * is reachable from more than one call path (the primary result, the
 * alternative-candidate retry), and guarding the route would leave the others.
 *
 * This is a *policy* control, not the SSRF control. `requestRemote()` remains
 * responsible for forcing HTTPS, refusing embedded credentials, and proving the
 * target resolves to a public address on every redirect hop. This function only
 * answers "is this host one the named provider is allowed to serve from", which
 * is why it inspects the client-supplied URL: that is the value the client
 * controls. Redirects to a provider's own CDN (archive.org -> iaNNNN.us.archive.org)
 * stay allowed by the subdomain rule below.
 */

class DownloadHostError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DownloadHostError';
    this.code = 'DOWNLOAD_HOST_NOT_ALLOWED';
    this.statusCode = 400;
  }
}

function normalizeHost(value) {
  return String(value || '').trim().toLowerCase().replace(/\.$/, '');
}

/**
 * Exact host match, or a subdomain of it. Compared label-wise so that
 * `evilgutenberg.org` and `gutenberg.org.attacker.test` are both refused --
 * a plain `endsWith` would accept the first.
 */
function hostMatches(host, allowed) {
  if (host === allowed) return true;
  return host.endsWith(`.${allowed}`);
}

function isAllowedDownloadHost(url, allowedHosts) {
  let parsed;
  try {
    parsed = url instanceof URL ? url : new URL(String(url));
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = normalizeHost(parsed.hostname);
  if (!host) return false;
  for (const entry of allowedHosts) {
    const allowed = normalizeHost(entry);
    if (allowed && hostMatches(host, allowed)) return true;
  }
  return false;
}

function assertAllowedDownloadHost(url, allowedHosts, providerLabel) {
  if (!isAllowedDownloadHost(url, allowedHosts)) {
    // The rejected host is deliberately not echoed back: the caller already
    // knows what it sent, and it keeps operator-configured OPDS hostnames out
    // of responses served to members.
    throw new DownloadHostError(`Download URL is not served by ${providerLabel}`);
  }
}

/**
 * The hosts a configured OPDS feed may serve downloads from. The feed URL is
 * operator-configured, so its host is the correct trust anchor -- unlike the
 * per-request URL, which is not.
 */
function opdsAllowedHosts(feedUrl) {
  try {
    return [new URL(String(feedUrl)).hostname];
  } catch {
    return [];
  }
}

const GUTENBERG_HOSTS = Object.freeze(['gutenberg.org', 'gutendex.com']);
const INTERNET_ARCHIVE_HOSTS = Object.freeze(['archive.org']);

module.exports = {
  DownloadHostError,
  GUTENBERG_HOSTS,
  INTERNET_ARCHIVE_HOSTS,
  assertAllowedDownloadHost,
  isAllowedDownloadHost,
  opdsAllowedHosts
};
