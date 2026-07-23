const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const { requestRemote, declaredLength, readBoundedBuffer, byteLimit } = require('../remote-fetch');

const ADVANCED_SEARCH_URL = 'https://archive.org/advancedsearch.php';
const METADATA_URL = 'https://archive.org/metadata';
const DOWNLOAD_URL = 'https://archive.org/download';
const SEARCH_TIMEOUT_MS = Number(process.env.INTERNET_ARCHIVE_SEARCH_TIMEOUT_MS || 12000);
const METADATA_TIMEOUT_MS = Number(process.env.INTERNET_ARCHIVE_METADATA_TIMEOUT_MS || 8000);
const DOWNLOAD_TIMEOUT_MS = Number(process.env.INTERNET_ARCHIVE_DOWNLOAD_TIMEOUT_MS || 45000);
const MAX_JSON_BYTES = Number(process.env.INTERNET_ARCHIVE_MAX_JSON_BYTES || 4 * 1024 * 1024);
const MAX_DOWNLOAD_BYTES = Number(process.env.INTERNET_ARCHIVE_MAX_DOWNLOAD_BYTES || 1024 * 1024 * 1024);
const USER_AGENT = 'Xandrio-Audiobook-Player/1.0';

function remoteOptions(timeoutMs) {
  return {
    timeoutMs,
    maxRedirects: 3,
    headersForUrl: () => ({ 'User-Agent': USER_AGENT })
  };
}

function safeHash(identifier) {
  return `ia-${String(identifier || '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120)}`;
}

function firstValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

function fileUrl(identifier, fileName) {
  return `${DOWNLOAD_URL}/${encodeURIComponent(identifier)}/${encodeURIComponent(fileName)}`;
}

function chooseDownloadFile(files = []) {
  const usable = files.filter(file => {
    const name = String(file.name || '');
    const format = String(file.format || '');
    return name && !/lcp|encrypted/i.test(name) && !/encrypted/i.test(format);
  });

  const epub = usable.find(file =>
    String(file.format || '').toLowerCase() === 'epub' &&
    /\.epub$/i.test(String(file.name || ''))
  );
  if (epub) return { file: epub, format: 'EPUB' };

  const pdf = usable.find(file =>
    /text pdf/i.test(String(file.format || '')) &&
    /\.pdf$/i.test(String(file.name || ''))
  );
  if (pdf) return { file: pdf, format: 'PDF' };

  return null;
}

async function fetchJson(url, timeoutMs) {
  const remote = await requestRemote(url, remoteOptions(timeoutMs));
  try {
    const { response } = remote;
    if (!response.ok) throw new Error(`Internet Archive API error: ${response.status} ${response.statusText}`);
    return JSON.parse((await readBoundedBuffer(response, MAX_JSON_BYTES)).toString('utf8'));
  } finally {
    remote.close();
  }
}

function normalizeLanguage(value) {
  const raw = firstValue(value);
  if (!raw) return '';
  const str = String(raw).toLowerCase();
  if (str === 'eng') return 'en';
  if (str.length === 3) return str.slice(0, 2);
  return str;
}

async function enrichDoc(doc) {
  const identifier = String(doc.identifier || '');
  if (!identifier) return null;
  const metadata = await fetchJson(`${METADATA_URL}/${encodeURIComponent(identifier)}`, METADATA_TIMEOUT_MS);
  const chosen = chooseDownloadFile(metadata.files || []);
  if (!chosen) return null;

  const title = firstValue(doc.title) || firstValue(metadata.metadata?.title) || identifier;
  const author = firstValue(doc.creator) || firstValue(metadata.metadata?.creator) || 'Unknown';
  const downloadUrl = fileUrl(identifier, chosen.file.name);
  return {
    title,
    author,
    format: chosen.format,
    size: formatBytes(chosen.file.size),
    hash: safeHash(identifier),
    iaIdentifier: identifier,
    iaFile: chosen.file.name,
    publisher: firstValue(doc.publisher) || firstValue(metadata.metadata?.publisher) || 'Internet Archive',
    language: normalizeLanguage(doc.language || metadata.metadata?.language),
    url: `https://archive.org/details/${encodeURIComponent(identifier)}`,
    source: 'internetarchive',
    downloadUrl,
    filePath: chosen.file.name,
    description: firstValue(metadata.metadata?.description),
    _year: firstValue(doc.year) || String(firstValue(doc.date) || '').slice(0, 4)
  };
}

async function search(query, opts = {}) {
  const rows = Number(opts.rows || process.env.INTERNET_ARCHIVE_SEARCH_ROWS || 12);
  const params = new URLSearchParams();
  params.set('q', `(${query}) AND mediatype:texts`);
  params.set('output', 'json');
  params.set('rows', String(Math.max(1, Math.min(rows, 30))));
  params.set('page', '1');
  for (const field of ['identifier', 'title', 'creator', 'date', 'year', 'language', 'publisher', 'downloads']) {
    params.append('fl[]', field);
  }
  params.set('sort[]', 'downloads desc');

  const body = await fetchJson(`${ADVANCED_SEARCH_URL}?${params}`, SEARCH_TIMEOUT_MS);
  const docs = Array.isArray(body.response?.docs) ? body.response.docs : [];
  const enriched = await Promise.allSettled(docs.map(doc => enrichDoc(doc)));
  return enriched
    .filter(result => result.status === 'fulfilled' && result.value)
    .map(result => result.value);
}

async function download(result, destPath) {
  const url = result.downloadUrl || (result.iaIdentifier && result.iaFile
    ? fileUrl(result.iaIdentifier, result.iaFile)
    : '');
  if (!url) throw new Error('Internet Archive result has no downloadable file');

  const remote = await requestRemote(url, remoteOptions(DOWNLOAD_TIMEOUT_MS));
  try {
    const { response } = remote;
    if (!response.ok) throw new Error(`Internet Archive download failed: ${response.status} ${response.statusText}`);
    if (!response.body) throw new Error('Internet Archive download returned an empty response');
    const length = declaredLength(response);
    if (length !== null && length > MAX_DOWNLOAD_BYTES) {
      throw new Error('Internet Archive download exceeds the allowed size');
    }

    await fs.mkdir(path.dirname(destPath), { recursive: true });
    const partPath = `${destPath}.part`;
    const fileStream = fsSync.createWriteStream(partPath);
    await pipeline(Readable.fromWeb(response.body), byteLimit(MAX_DOWNLOAD_BYTES), fileStream);
    await fs.rename(partPath, destPath);
  } catch (err) {
    await fs.unlink(`${destPath}.part`).catch(() => {});
    throw err;
  } finally {
    remote.close();
  }
}

module.exports = {
  search,
  download,
  __test: {
    chooseDownloadFile,
    safeHash,
    formatBytes
  }
};
