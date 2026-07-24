// The EPUB package is ESM-only from v2 onward. Keep that boundary here so
// CommonJS application modules share one promise-based parser contract.

let EPubConstructor;

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
  const titles = [...String(ncx).matchAll(/<navLabel\b[^>]*>[\s\S]*?<text\b[^>]*>([\s\S]*?)<\/text>/gi)]
    .map(match => decodeXmlText(match[1]));
  if (titles.length !== epub.toc.length) return;

  for (let index = 0; index < epub.toc.length; index++) {
    if (!epub.toc[index].title && titles[index]) epub.toc[index].title = titles[index];
  }
}

async function loadEPubConstructor() {
  if (!EPubConstructor) {
    const module = await import('epub');
    EPubConstructor = module.default || module.EPub;
  }
  return EPubConstructor;
}

async function parseEpub(input, imageWebRoot = '', chapterWebRoot = '') {
  const EPub = await loadEPubConstructor();
  const epub = new EPub(input, imageWebRoot, chapterWebRoot);
  await epub.parse();
  await restoreNumericTocTitles(epub);

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

module.exports = { parseEpub };
