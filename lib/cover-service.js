const fs = require('fs').promises;
const {
  cleanAuthorForIdentity,
  cleanTitleForIdentity,
  normalizeMetadataText
} = require('./metadata-service');
const { parseEpub } = require('./epub-parser');
const { requestRemote, readBoundedBuffer } = require('./remote-fetch');

const COVER_TIMEOUT_MS = 15000;
const MAX_COVER_BYTES = 8 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_COVER_PAGE_BYTES = 768 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IEND_CHUNK = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

function remoteRequestOptions(options = {}, timeoutMs = COVER_TIMEOUT_MS) {
  return {
    fetchImpl: options.fetchImpl,
    lookupImpl: options.lookupImpl,
    timeoutMs,
    maxRedirects: 3,
    headersForUrl: () => ({
      'Accept': 'image/jpeg,image/png,image/*;q=0.8,application/json;q=0.6',
      'User-Agent': 'Xandrio-Audiobook-Player/1.0'
    })
  };
}

async function fetchRemoteBuffer(url, options, maxBytes = MAX_COVER_BYTES, timeoutMs = COVER_TIMEOUT_MS, maxRedirects = 3) {
  const remote = await requestRemote(url, {
    ...remoteRequestOptions(options, timeoutMs),
    maxRedirects
  });
  try {
    if (!remote.response.ok) throw new Error(`Remote request failed: ${remote.response.status}`);
    return await readBoundedBuffer(remote.response, maxBytes);
  } finally {
    remote.close();
  }
}

async function fetchRemoteJson(url, options, timeoutMs = COVER_TIMEOUT_MS) {
  const data = await fetchRemoteBuffer(url, options, MAX_JSON_BYTES, timeoutMs);
  return JSON.parse(data.toString('utf8'));
}

// Write a cover image atomically (temp + rename) so an interrupted fetch
// can never leave a truncated file that later reads treat as a valid cover.
async function writeCoverAtomic(outputPath, data) {
  if (!isSupportedCoverBuffer(data)) throw new Error('Unsupported cover image format');
  const partPath = `${outputPath}.part`;
  await fs.writeFile(partPath, data);
  await fs.rename(partPath, outputPath);
}

function decodeHtmlAttribute(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function htmlAttribute(tag, name) {
  const match = String(tag || '').match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
  return match ? decodeHtmlAttribute(match[2]) : '';
}

function annasPageCoverUrl(html, pageUrl) {
  for (const match of String(html || '').matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const className = htmlAttribute(tag, 'class');
    if (!/(?:^|\s)object-cover(?:\s|$)/i.test(className)) continue;
    const src = htmlAttribute(tag, 'src');
    if (!src) return null;
    try {
      const url = new URL(src, pageUrl);
      return url.protocol === 'https:' ? url.href : null;
    } catch {
      return null;
    }
  }
  return null;
}

function isSupportedCoverBuffer(buffer) {
  return Boolean(getSupportedCoverDimensions(buffer));
}

function getSupportedCoverDimensions(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    return hasJpegEndMarker(buffer) ? getJpegDimensions(buffer) : null;
  }
  if (buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return hasPngEndChunk(buffer) ? getPngDimensions(buffer) : null;
  }
  return null;
}

function hasJpegEndMarker(buffer) {
  return buffer.length >= 4 && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;
}

function hasPngEndChunk(buffer) {
  return buffer.length >= PNG_IEND_CHUNK.length && buffer.subarray(-PNG_IEND_CHUNK.length).equals(PNG_IEND_CHUNK);
}

function isBareHttpsOrigin(url) {
  return url.protocol === 'https:' && !url.username && !url.password &&
    url.pathname === '/' && !url.search && !url.hash;
}

async function fetchCoverFromAnnasPage(pageUrl, outputPath, options = {}) {
  try {
    const page = new URL(String(pageUrl || ''));
    const expectedOrigin = new URL(String(options.expectedOrigin || ''));
    if (!isBareHttpsOrigin(expectedOrigin) || page.protocol !== 'https:' || page.username || page.password ||
        page.origin !== expectedOrigin.origin || !/^\/md5\/[a-f0-9]{32}$/i.test(page.pathname) ||
        page.search || page.hash) return false;

    // Do not follow an edition-page redirect: the configured Anna origin is
    // part of the trust boundary, while cover images may live on a CDN.
    const html = (await fetchRemoteBuffer(page.href, options, MAX_COVER_PAGE_BYTES, 15000, 0)).toString('utf8');
    const coverUrl = annasPageCoverUrl(html, page);
    if (!coverUrl) return false;

    const image = await fetchRemoteBuffer(coverUrl, options, MAX_COVER_BYTES, 15000);
    if (!isSupportedCoverBuffer(image)) return false;
    const dimensions = getSupportedCoverDimensions(image);
    const ratio = dimensions.width / dimensions.height;
    if (dimensions.width < 96 || dimensions.height < 128 || ratio < 0.42 || ratio > 1.12) return false;

    await writeCoverAtomic(outputPath, image);
    console.log(`[cover] Saved Anna edition cover: ${dimensions.width}x${dimensions.height} (${Math.round(image.length / 1024)}KB)`);
    return true;
  } catch {
    return false;
  }
}


function getJpegDimensions(buffer) {
  // Kept as the legacy public helper name; callers historically use it for
  // both JPEG and PNG covers.
  if (Buffer.isBuffer(buffer) && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return getPngDimensions(buffer);
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;

  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset++];
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) return null;
    const length = buffer.readUInt16BE(offset);
    if (length < 8 || offset + length > buffer.length) return null;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      const components = buffer[offset + 7];
      if (!components || length !== 8 + (components * 3)) return null;
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      return width && height ? { width, height } : null;
    }
    offset += length;
  }
  return null;
}

function getPngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE) ||
      buffer.readUInt32BE(8) !== 13 || !buffer.subarray(12, 16).equals(Buffer.from('IHDR'))) return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const bitDepth = buffer[24];
  const colorType = buffer[25];
  const validBitDepth = (
    (colorType === 0 && [1, 2, 4, 8, 16].includes(bitDepth)) ||
    (colorType === 2 && [8, 16].includes(bitDepth)) ||
    (colorType === 3 && [1, 2, 4, 8].includes(bitDepth)) ||
    ((colorType === 4 || colorType === 6) && [8, 16].includes(bitDepth))
  );
  if (!width || !height || !validBitDepth || buffer[26] !== 0 || buffer[27] !== 0 || buffer[28] > 1) return null;
  return { width, height };
}

function looksLikeGeneratedPlaceholderCover(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 1024) return false;
  const dims = getJpegDimensions(buffer);
  if (!dims || dims.width < 120 || dims.height < 160) return false;

  const isJpeg = buffer[0] === 0xFF && buffer[1] === 0xD8;
  if (isJpeg) return false;

  // Currently used for PNG placeholder fixtures and future non-JPEG embedded
  // covers. JPEG pixel decoding is intentionally avoided here because this app
  // has no image-processing dependency; catalog-first ordering handles the
  // common real-world JPEG placeholder case.
  if (buffer[0] !== 0x89 || buffer[1] !== 0x50) return false;

  // This is a conservative structural heuristic for generated placeholder
  // covers: PNGs with very low encoded entropy relative to their dimensions.
  // Real photographic/illustrated covers are much harder to compress.
  const bytesPerPixel = buffer.length / Math.max(1, dims.width * dims.height);
  return bytesPerPixel < 0.08;
}

function metadataTokenSimilarity(a, b) {
  const aTokens = new Set(normalizeMetadataText(a).split(' ').filter(token => token.length > 2));
  const bTokens = new Set(normalizeMetadataText(b).split(' ').filter(token => token.length > 2));
  if (!aTokens.size || !bTokens.size) return 0;
  let matches = 0;
  for (const token of aTokens) if (bTokens.has(token)) matches += 1;
  return matches / Math.max(aTokens.size, bTokens.size);
}

function isGoogleBooksCoverMatch(volumeInfo, title, author) {
  const requestedTitle = cleanTitleForIdentity(title, author);
  const candidateTitle = cleanTitleForIdentity(volumeInfo?.title || '');
  const titleSimilarity = metadataTokenSimilarity(requestedTitle, candidateTitle);
  if (titleSimilarity < 0.8) return false;

  const requestedAuthor = cleanAuthorForIdentity(author);
  const candidateAuthors = Array.isArray(volumeInfo?.authors) ? volumeInfo.authors.join(' ') : '';
  if (!requestedAuthor || !candidateAuthors) return titleSimilarity >= 0.95;
  return metadataTokenSimilarity(requestedAuthor, candidateAuthors) >= 0.6;
}

async function fetchCoverFromGoogleBooks(title, author, outputPath, options = {}) {
  try {
    const cleanTitle = cleanTitleForIdentity(title, author);
    const cleanAuthor = cleanAuthorForIdentity(author);
    const query = cleanAuthor ? `intitle:"${cleanTitle}" inauthor:"${cleanAuthor}"` : `intitle:"${cleanTitle}"`;
    const searchUrl = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=5`;
    console.log(`[cover] Google Books search: ${cleanTitle} by ${cleanAuthor || 'unknown'}`);

    const data = await fetchRemoteJson(searchUrl, options, 10000);
    if (data.error) {
      console.log(`[cover] Google Books API error: ${data.error.message?.substring(0, 80)}`);
      return false;
    }

    if (!data.items || data.items.length === 0) {
      console.log('[cover] No Google Books results');
      return false;
    }

    for (const item of data.items) {
      if (!isGoogleBooksCoverMatch(item.volumeInfo, title, author)) continue;
      const imageLinks = item.volumeInfo?.imageLinks;
      if (!imageLinks) continue;

      let coverUrl = imageLinks.extraLarge || imageLinks.large || imageLinks.medium || imageLinks.thumbnail;
      if (!coverUrl) continue;

      coverUrl = coverUrl.replace(/&zoom=\d/, '&zoom=3').replace('http://', 'https://');
      coverUrl = coverUrl.replace('&edge=curl', '');

      console.log(`[cover] Google Books: trying ${coverUrl.substring(0, 100)}...`);
      let imageBuffer;
      try {
        imageBuffer = await fetchRemoteBuffer(coverUrl, options, MAX_COVER_BYTES, 10000);
      } catch {
        continue;
      }
      const dims = getSupportedCoverDimensions(imageBuffer);
      if (!dims) continue;
      if (dims.width < 200) {
        console.log(`[cover] Google Books image too small: ${dims.width}x${dims.height}, skipping`);
        continue;
      }

      await writeCoverAtomic(outputPath, imageBuffer);
      console.log(`[cover] Saved Google Books cover: ${dims ? dims.width + 'x' + dims.height : 'unknown'} (${Math.round(imageBuffer.length / 1024)}KB)`);
      return true;
    }

    return false;
  } catch (err) {
    console.error('[cover] Google Books error:', err.message);
    return false;
  }
}

async function fetchCoverByISBN(isbn, outputPath, options = {}) {
  try {
    for (const size of ['L', 'M']) {
      const url = `https://covers.openlibrary.org/b/isbn/${isbn}-${size}.jpg?default=false`;
      let buf;
      try {
        buf = await fetchRemoteBuffer(url, options, MAX_COVER_BYTES, 10000);
      } catch {
        continue;
      }
      if (buf.length < 100) continue;

      const dims = getSupportedCoverDimensions(buf);
      if (dims && dims.width >= 300) {
        await writeCoverAtomic(outputPath, buf);
        console.log(`[cover] ISBN ${isbn} cover: ${dims.width}x${dims.height} (${Math.round(buf.length / 1024)}KB)`);
        return true;
      }
    }
    return false;
  } catch (err) {
    return false;
  }
}

async function fetchCoverFromOpenLibrary(title, author, outputPath, options = {}) {
  try {
    const cleanTitle = title
      .replace(/\s*\([^)]*\)\s*/g, '')
      .replace(/\s*\[[^\]]*\]\s*/g, '')
      .trim();

    const normalizeAuthor = (name) => {
      if (!name) return '';
      return name.toLowerCase()
        .replace(/[^a-z\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .split(' ')
        .filter(w => w.length > 1);
    };

    const authorWords = normalizeAuthor(author);
    const authorMatches = (doc) => {
      if (!authorWords.length) return true;
      if (!doc.author_name || doc.author_name.length === 0) return false;
      return doc.author_name.some(docAuthor => {
        const docWords = normalizeAuthor(docAuthor);
        return authorWords.some(w => docWords.includes(w));
      });
    };

    const searchQuery = author ? `${cleanTitle} ${author}` : cleanTitle;
    let searchUrl = `https://openlibrary.org/search.json?q=${encodeURIComponent(searchQuery)}&limit=5`;
    let searchData = await fetchRemoteJson(searchUrl, options, 10000);

    if ((!searchData.docs || searchData.docs.length === 0) && author) {
      searchUrl = `https://openlibrary.org/search.json?q=${encodeURIComponent(cleanTitle)}&limit=5`;
      searchData = await fetchRemoteJson(searchUrl, options, 10000);
    }

    if (!searchData.docs || searchData.docs.length === 0) {
      console.log('No results from Open Library');
      return false;
    }

    const bookWithCover = searchData.docs.find(doc => doc.cover_i && authorMatches(doc));
    if (!bookWithCover) {
      console.log(`No author-matched cover found for "${title}" by "${author}", skipping to avoid wrong cover`);
      return false;
    }

    console.log(`Open Library match: "${bookWithCover.title}" by ${bookWithCover.author_name?.join(', ')} (cover_i: ${bookWithCover.cover_i})`);

    const isbns = bookWithCover.isbn || [];
    for (const isbn of isbns.slice(0, 3)) {
      const gotIsbn = await fetchCoverByISBN(isbn, outputPath, options);
      if (gotIsbn) return true;
    }

    const coverId = bookWithCover.cover_i;
    const minCoverWidth = 300;
    for (const size of ['L', 'M']) {
      const coverUrl = `https://covers.openlibrary.org/b/id/${coverId}-${size}.jpg`;
      console.log(`[cover] Trying Open Library ${size === 'L' ? 'Large' : 'Medium'}: ${coverUrl}`);
      let imageBuffer;
      try {
        imageBuffer = await fetchRemoteBuffer(coverUrl, options, MAX_COVER_BYTES, 15000);
      } catch {
        continue;
      }
      const dims = getSupportedCoverDimensions(imageBuffer);
      if (!dims) continue;
      if (dims && dims.width < minCoverWidth && size === 'L') {
        console.log(`[cover] Large too small (${dims.width}x${dims.height}), trying Medium...`);
        continue;
      }

      await writeCoverAtomic(outputPath, imageBuffer);
      console.log(`[cover] Saved Open Library ${size}: ${dims ? dims.width + 'x' + dims.height : 'unknown'} (${Math.round(imageBuffer.length / 1024)}KB)`);
      return true;
    }

    console.log('[cover] Failed to fetch cover from Open Library');
    return false;
  } catch (err) {
    console.error('Open Library API error:', err.message);
    return false;
  }
}

async function fetchCoverByOpenLibraryWorkKey(workKey, outputPath, options = {}) {
  try {
    const normalizedWorkKey = String(workKey || '').replace(/^\/?works\//, '').trim();
    if (!normalizedWorkKey) return false;

    const workUrl = `https://openlibrary.org/works/${encodeURIComponent(normalizedWorkKey)}.json`;
    const work = await fetchRemoteJson(workUrl, options, 10000);
    const coverIds = Array.isArray(work.covers) ? work.covers.filter(Number.isFinite) : [];
    for (const coverId of coverIds.slice(0, 4)) {
      for (const size of ['L', 'M']) {
        const coverUrl = `https://covers.openlibrary.org/b/id/${coverId}-${size}.jpg`;
        let imageBuffer;
        try {
          imageBuffer = await fetchRemoteBuffer(coverUrl, options, MAX_COVER_BYTES, 10000);
        } catch {
          continue;
        }
        if (imageBuffer.length < 100) continue;

        const dims = getSupportedCoverDimensions(imageBuffer);
        if (!dims) continue;
        if (dims && dims.width < 200) continue;

        await writeCoverAtomic(outputPath, imageBuffer);
        console.log(`[cover] Saved Open Library work cover ${coverId}: ${dims ? dims.width + 'x' + dims.height : 'unknown'} (${Math.round(imageBuffer.length / 1024)}KB)`);
        return true;
      }
    }

    return false;
  } catch (err) {
    console.error('[cover] Open Library work cover error:', err.message);
    return false;
  }
}

async function fetchCoverFromGutenbergId(gutenbergId, outputPath, options = {}) {
  const id = String(gutenbergId || '').match(/\d+/)?.[0];
  if (!id) return false;

  const candidates = [
    `https://www.gutenberg.org/cache/epub/${id}/pg${id}.cover.medium.jpg`,
    `https://www.gutenberg.org/cache/epub/${id}/pg${id}.cover.small.jpg`
  ];

  for (const coverUrl of candidates) {
    try {
      const imageBuffer = await fetchRemoteBuffer(coverUrl, options, MAX_COVER_BYTES, 10000);
      if (imageBuffer.length < 100) continue;

      const dims = getSupportedCoverDimensions(imageBuffer);
      if (!dims) continue;
      if (dims && dims.width < 120) continue;

      await writeCoverAtomic(outputPath, imageBuffer);
      console.log(`[cover] Saved Project Gutenberg cover: ${dims ? dims.width + 'x' + dims.height : 'unknown'} (${Math.round(imageBuffer.length / 1024)}KB)`);
      return true;
    } catch (err) {
      console.error('[cover] Gutenberg cover error:', err.message);
    }
  }

  return false;
}

async function extractCover(epubPath, outputPath) {
  try {
    const epub = await parseEpub(epubPath);
    const data = await epub.getImage(epub.metadata.cover);
    if (!data) {
      console.log('No cover image found in EPUB');
      return false;
    }
    if (!isSupportedCoverBuffer(data)) {
      console.log('Embedded EPUB cover is not a supported JPEG or PNG image; skipping');
      return false;
    }
    if (looksLikeGeneratedPlaceholderCover(data)) {
      console.log('Embedded EPUB cover looks like a generated placeholder; skipping');
      return false;
    }
    await writeCoverAtomic(outputPath, data);
    console.log('Cover extracted successfully');
    return true;
  } catch (err) {
    console.error('EPUB parse error for cover:', err);
    return false;
  }
}

module.exports = {
  getJpegDimensions,
  looksLikeGeneratedPlaceholderCover,
  isGoogleBooksCoverMatch,
  fetchCoverFromGoogleBooks,
  fetchCoverByISBN,
  fetchCoverFromOpenLibrary,
  fetchCoverByOpenLibraryWorkKey,
  fetchCoverFromGutenbergId,
  fetchCoverFromAnnasPage,
  extractCover
};
