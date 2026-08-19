// The EPUB package is ESM-only from v2 onward. Keep that boundary here so
// CommonJS application modules share one promise-based parser contract.

const fsp = require('fs').promises;

let EPubConstructor;

// A ZIP entry's *uncompressed* size is declared in the central directory, so a
// decompression bomb can be refused before a single byte is inflated. Deflate
// reaches roughly 1000:1 on repetitive filler, which turns a few hundred KB of
// EPUB into gigabytes of resident memory once the OPF or a chapter is read as
// both a Buffer and a string. Real books are nowhere near these bounds.
const MAX_EPUB_ENTRY_BYTES = 512 * 1024 * 1024;
const MAX_EPUB_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
// The end-of-central-directory record is at most 22 bytes plus a 64 KB comment.
const EOCD_SEARCH_BYTES = 22 + 0xffff;

class EpubTooLargeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EpubTooLargeError';
    this.code = 'EPUB_UNCOMPRESSED_TOO_LARGE';
  }
}

/**
 * Walks the ZIP central directory and sums the declared uncompressed sizes.
 *
 * Deliberately tolerant: anything it cannot parse (ZIP64, a prepended stub, a
 * truncated directory) returns null and the import proceeds as before. The
 * goal is to refuse the obvious bomb cheaply, not to reimplement a ZIP reader
 * or to start rejecting books that used to work.
 */
async function declaredUncompressedSize(filePath) {
  let handle;
  try {
    handle = await fsp.open(filePath, 'r');
    const { size } = await handle.stat();
    if (!Number.isFinite(size) || size < 22) return null;

    const tailLength = Math.min(size, EOCD_SEARCH_BYTES);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);
    let eocd = -1;
    for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
      if (tail.readUInt32LE(offset) === EOCD_SIGNATURE) { eocd = offset; break; }
    }
    if (eocd === -1) return null;

    const entryCount = tail.readUInt16LE(eocd + 10);
    const directorySize = tail.readUInt32LE(eocd + 12);
    const directoryOffset = tail.readUInt32LE(eocd + 16);
    // 0xffff / 0xffffffff are the ZIP64 escape values; fall through untouched.
    if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) return null;
    if (directoryOffset + directorySize > size) return null;

    const directory = Buffer.alloc(directorySize);
    await handle.read(directory, 0, directorySize, directoryOffset);

    let total = 0;
    let largest = 0;
    let cursor = 0;
    for (let index = 0; index < entryCount; index += 1) {
      if (cursor + 46 > directory.length) return null;
      if (directory.readUInt32LE(cursor) !== CENTRAL_HEADER_SIGNATURE) return null;
      const uncompressed = directory.readUInt32LE(cursor + 24);
      // A ZIP64 entry parks 0xffffffff here and puts the real size in an extra
      // field. Rather than parse that, decline to judge the archive at all.
      if (uncompressed === 0xffffffff) return null;
      total += uncompressed;
      if (uncompressed > largest) largest = uncompressed;
      cursor += 46
        + directory.readUInt16LE(cursor + 28)
        + directory.readUInt16LE(cursor + 30)
        + directory.readUInt16LE(cursor + 32);
    }
    return { total, largest, entryCount };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function assertEpubWithinLimits(filePath) {
  if (typeof filePath !== 'string' || !filePath) return;
  const declared = await declaredUncompressedSize(filePath);
  if (!declared) return;
  if (declared.largest > MAX_EPUB_ENTRY_BYTES) {
    throw new EpubTooLargeError(
      `EPUB contains a ${declared.largest}-byte entry, above the ${MAX_EPUB_ENTRY_BYTES}-byte limit`
    );
  }
  if (declared.total > MAX_EPUB_TOTAL_BYTES) {
    throw new EpubTooLargeError(
      `EPUB expands to ${declared.total} bytes, above the ${MAX_EPUB_TOTAL_BYTES}-byte limit`
    );
  }
}

// The OPF, NCX and container.xml come out of an attacker-supplied ZIP and are
// scanned with regexes. Deflate compresses repetitive filler about 1000:1, so
// a ~1 KB EPUB can expand to megabytes here. Node is single-threaded, so any
// super-linear scan over that input stalls the whole server. Real packages are
// far below this bound; anything above it is not a book.
const MAX_XML_SCAN_BYTES = 4 * 1024 * 1024;

// Returns null when the document is too large to scan. Both callers are
// best-effort refinements (spine linearity, numeric TOC titles), so skipping
// the scan degrades metadata quality rather than failing an import that would
// otherwise succeed.
function boundedXml(text, label) {
  const value = String(text || '');
  if (value.length > MAX_XML_SCAN_BYTES) {
    console.warn(`epub-parser: skipping ${label} scan, ${value.length} bytes exceeds ${MAX_XML_SCAN_BYTES}`);
    return null;
  }
  return value;
}

function decodeXmlText(value) {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

async function restoreNumericTocTitles(epub) {
  if (!epub.toc.some(item => !item.title) || !epub.spine.toc?.href) return;

  let ncx;
  try {
    ncx = await epub.readFile(epub.spine.toc.href, 'utf8');
  } catch {
    return;
  }
  const boundedNcx = boundedXml(ncx, 'navigation document');
  if (boundedNcx === null) return;

  const titles = ncxNavLabelTitles(boundedNcx).map(decodeXmlText);
  if (titles.length !== epub.toc.length) return;

  for (let index = 0; index < epub.toc.length; index++) {
    if (!epub.toc[index].title && titles[index]) epub.toc[index].title = titles[index];
  }
}

/**
 * Recovers <navLabel><text> titles from an NCX by index scanning.
 *
 * The obvious regex -- /<navLabel\b[^>]*>[\s\S]*?<text\b[^>]*>([\s\S]*?)<\/text>/gi
 * -- is quadratic on hostile input: every <navLabel with no <text> after it
 * makes the lazy [\s\S]*? rescan to end of input before failing. Measured, a
 * 4 MB document of empty <navLabel></navLabel> pairs blocked the event loop for
 * ~33 seconds, and that document compresses to almost nothing inside the EPUB.
 * Node is single-threaded, so that is the whole server, not one request.
 *
 * Index scanning has no backtracking: each position is examined a bounded
 * number of times regardless of what the document contains. It also fixes a
 * correctness bug in passing -- the regex would pair a <navLabel> with a <text>
 * belonging to a *later* element, while this requires the text to sit inside
 * the label it is attributed to.
 */
function ncxNavLabelTitles(xml) {
  const titles = [];
  const lower = xml.toLowerCase();
  let cursor = 0;
  for (;;) {
    const labelStart = lower.indexOf('<navlabel', cursor);
    if (labelStart === -1) break;
    const labelOpenEnd = lower.indexOf('>', labelStart);
    if (labelOpenEnd === -1) break;
    const labelClose = lower.indexOf('</navlabel', labelOpenEnd);
    const textStart = lower.indexOf('<text', labelOpenEnd);
    if (textStart === -1) break;
    if (labelClose !== -1 && textStart > labelClose) {
      // This navLabel holds no text element; move past it rather than
      // borrowing the next one's.
      cursor = labelClose + '</navlabel'.length;
      continue;
    }
    const textOpenEnd = lower.indexOf('>', textStart);
    if (textOpenEnd === -1) break;
    const textClose = lower.indexOf('</text', textOpenEnd);
    if (textClose === -1) break;
    titles.push(xml.slice(textOpenEnd + 1, textClose));
    cursor = textClose + '</text'.length;
  }
  return titles;
}

async function restoreSpineLinearity(epub) {
  if (!epub.zip) return false;

  let opfPath = '';
  try {
    const containerFile = epub.zip.file('META-INF/container.xml');
    const container = (containerFile ? boundedXml(await containerFile.async('string'), 'container.xml') : '') || '';
    opfPath = container.match(/<rootfile\b[^>]*\bfull-path=["']([^"']+)["']/i)?.[1] || '';
  } catch {}
  if (!opfPath || !epub.zip.file(opfPath)) {
    opfPath = Object.keys(epub.zip.files || {}).find(name => /\.opf$/i.test(name)) || '';
  }
  if (!opfPath) return false;

  let opf;
  try {
    opf = await epub.zip.file(opfPath).async('string');
  } catch {
    return false;
  }

  const linearById = new Map();
  // Matching straight to '>' is deterministic because [^>]* cannot cross it.
  // The previous ([^>]*)\/?\s*> overlapped [^>]* with \s*, which backtracked
  // quadratically: 160 KB of spaces after an unterminated <itemref took ~11 s.
  // The optional slash and trailing space are absorbed by [^>]* and trimmed
  // from the captured attributes instead.
  const boundedOpf = boundedXml(opf, 'package document');
  if (boundedOpf === null) return false;

  for (const match of boundedOpf.matchAll(/<itemref\b([^>]*)>/gi)) {
    const attributes = match[1].replace(/\/\s*$/, '');
    const idref = attributes.match(/\bidref=["']([^"']+)["']/i)?.[1];
    if (!idref) continue;
    const linear = attributes.match(/\blinear=["']([^"']+)["']/i)?.[1];
    linearById.set(idref, String(linear || 'yes').toLowerCase() !== 'no');
  }

  const collections = [epub.flow, epub.spine?.contents];
  for (const contents of collections) {
    if (!Array.isArray(contents)) continue;
    for (const item of contents) {
      if (linearById.has(item.id)) item.linear = linearById.get(item.id);
    }
  }
  return linearById.size > 0 &&
    Array.isArray(epub.flow) &&
    epub.flow.length > 0 &&
    epub.flow.every(item => linearById.has(item.id));
}

async function loadEPubConstructor() {
  if (!EPubConstructor) {
    const module = await import('epub');
    EPubConstructor = module.default || module.EPub;
  }
  return EPubConstructor;
}

async function parseEpub(input, imageWebRoot = '', chapterWebRoot = '') {
  // Refuse a decompression bomb from the central directory, before the epub
  // package inflates the OPF/NCX into memory.
  await assertEpubWithinLimits(input);
  const EPub = await loadEPubConstructor();
  const epub = new EPub(input, imageWebRoot, chapterWebRoot);
  await epub.parse();
  await restoreNumericTocTitles(epub);
  epub.spineLinearityVerified = await restoreSpineLinearity(epub);

  // Some EPUBs percent-encode manifest hrefs while their ZIP entries use
  // literal Unicode or spaces. v1's ZIP reader accepted those paths; JSZip
  // requires an exact entry name.
  for (const item of Object.values(epub.manifest)) {
    if (!item.href || epub.zip.file(item.href)) continue;
    try {
      const decodedHref = decodeURIComponent(item.href);
      if (epub.zip.file(decodedHref)) item.href = decodedHref;
    } catch {}
  }

  // v1 returned a Buffer from getImage's callback while v2 returns an object
  // with data and mimeType. Preserve the application's existing Buffer API.
  const getImage = epub.getImage.bind(epub);
  epub.getImage = async id => (await getImage(id)).data;
  return epub;
}

module.exports = {
  parseEpub,
  EpubTooLargeError,
  MAX_EPUB_ENTRY_BYTES,
  MAX_EPUB_TOTAL_BYTES,
  __test: { declaredUncompressedSize, assertEpubWithinLimits, ncxNavLabelTitles }
};
