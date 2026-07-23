const fs = require('fs').promises;
const fsSync = require('fs');
const dns = require('dns').promises;
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const { isPublicAddress, isSafeRemoteUrl, requestRemote, declaredLength, readBoundedBuffer, byteLimit } = require('../remote-fetch');

const MAX_FEED_BYTES = 4 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;

function textContent(xml, tag) {
  const match = String(xml || '').match(new RegExp(`<[^:>]*:?${tag}[^>]*>([\\s\\S]*?)<\\/[^:>]*:?${tag}>`, 'i'));
  return match ? decodeXml(match[1].replace(/<[^>]+>/g, '').trim()) : '';
}

function attr(tag, name) {
  const match = String(tag || '').match(new RegExp(`\\s${name}=["']([^"']+)["']`, 'i'));
  return match ? decodeXml(match[1]) : '';
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

function entryBlocks(xml) {
  return [...String(xml || '').matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map(match => match[0]);
}

function linkTags(entry) {
  return [...String(entry || '').matchAll(/<link\b[^>]*\/?>/gi)].map(match => match[0]);
}

function acquisitionLink(entry) {
  const links = linkTags(entry);
  return links.find(link =>
    /rel=["'][^"']*(?:acquisition|open-access)[^"']*["']/i.test(link) &&
    /type=["']application\/epub\+zip["']/i.test(link)
  ) || links.find(link => /type=["']application\/epub\+zip["']/i.test(link));
}

function parseOpdsFeed(xml, options = {}) {
  const source = options.source || 'opds';
  const publisher = options.publisher || options.label || 'OPDS';
  return entryBlocks(xml).map(entry => {
    const entryLinks = linkTags(entry);
    const link = acquisitionLink(entry);
    const href = attr(link, 'href');
    if (!href) return null;
    const id = textContent(entry, 'id') || href;
    const title = textContent(entry, 'title') || path.basename(href);
    const author = textContent(entry, 'name') || textContent(entry, 'creator') || 'Unknown';
    const rights = textContent(entry, 'rights');
    const licenseLink = entryLinks.find(candidate => /rel=["'][^"']*license[^"']*["']/i.test(candidate));
    const license = attr(licenseLink, 'href');
    return {
      title,
      author,
      format: 'EPUB',
      size: '',
      hash: `${source}-${id.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 110)}`,
      opdsId: id,
      publisher,
      language: textContent(entry, 'language'),
      url: textContent(entry, 'id') || href,
      source,
      downloadUrl: new URL(href, options.feedUrl).toString(),
      description: textContent(entry, 'summary') || textContent(entry, 'content'),
      rights: rights || undefined,
      license: license ? new URL(license, options.feedUrl).toString() : undefined
    };
  }).filter(Boolean);
}

function matchesQuery(result, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = `${result.title || ''} ${result.author || ''}`.toLowerCase();
  return words.every(word => haystack.includes(word));
}

function createOpdsProvider(options = {}) {
  const id = options.id || 'opds';
  const label = options.label || 'OPDS';
  const feedUrl = options.feedUrl;
  const username = options.username || '';
  const password = options.password || '';
  const timeoutMs = Number(options.timeoutMs || 12000);
  const downloadTimeoutMs = Number(options.downloadTimeoutMs || 45000);
  const fetchImpl = options.fetchImpl;
  const lookupImpl = options.lookupImpl || dns.lookup;
  const maxFeedBytes = Number(options.maxFeedBytes || MAX_FEED_BYTES);
  const maxDownloadBytes = Number(options.maxDownloadBytes || MAX_DOWNLOAD_BYTES);
  const credentialOrigin = feedUrl ? new URL(feedUrl).origin : null;

  function configured() {
    return Boolean(feedUrl) && (options.requiresAuth ? Boolean(username) : true);
  }

  function headers(includeAuthorization = true) {
    const result = { 'User-Agent': 'Xandrio-Audiobook-Player/1.0' };
    if (username && includeAuthorization) {
      result.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    }
    return result;
  }

  function request(url, requestTimeoutMs) {
    return requestRemote(url, {
      fetchImpl,
      lookupImpl,
      timeoutMs: requestTimeoutMs,
      headersForUrl: current => headers(current.origin === credentialOrigin)
    });
  }

  async function fetchFeed() {
    if (!configured()) return [];
    const remote = await request(feedUrl, timeoutMs);
    let xml;
    try {
      const { response } = remote;
      if (!response.ok) throw new Error(`${label} OPDS feed failed: ${response.status} ${response.statusText}`);
      xml = (await readBoundedBuffer(response, maxFeedBytes)).toString('utf8');
    } finally {
      remote.close();
    }
    return parseOpdsFeed(xml, { source: id, label, publisher: label, feedUrl });
  }

  async function search(query) {
    const entries = await fetchFeed();
    return entries.filter(entry => matchesQuery(entry, query));
  }

  async function download(result, destPath) {
    if (!result.downloadUrl) throw new Error(`${label} result has no download URL`);
    const remote = await request(result.downloadUrl, downloadTimeoutMs);
    try {
      const { response } = remote;
      if (!response.ok) throw new Error(`${label} download failed: ${response.status} ${response.statusText}`);
      if (!response.body) throw new Error(`${label} download returned an empty response`);
      const length = declaredLength(response);
      if (length !== null && length > maxDownloadBytes) throw new Error(`${label} download exceeds the allowed size`);
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      const partPath = `${destPath}.part`;
      const fileStream = fsSync.createWriteStream(partPath);
      await pipeline(Readable.fromWeb(response.body), byteLimit(maxDownloadBytes), fileStream);
      await fs.rename(partPath, destPath);
    } catch (err) {
      await fs.unlink(`${destPath}.part`).catch(() => {});
      throw err;
    } finally {
      remote.close();
    }
  }

  return { id, label, configured, search, download };
}

module.exports = {
  createOpdsProvider,
  parseOpdsFeed,
  __test: {
    acquisitionLink,
    isPublicAddress,
    isSafeRemoteUrl,
    matchesQuery,
    parseOpdsFeed
  }
};
