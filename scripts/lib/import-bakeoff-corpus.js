const crypto = require('node:crypto');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');

const SUPPORTED_FORMATS = new Set(['epub', 'mobi', 'prc', 'azw', 'azw3', 'pdf']);

async function sha256File(filePath, label = 'source file') {
  try {
    return await new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const input = fs.createReadStream(filePath);
      input.on('error', reject);
      input.on('data', chunk => hash.update(chunk));
      input.on('end', () => resolve(hash.digest('hex')));
    });
  } catch {
    throw new Error(`Import bake-off could not read ${label}`);
  }
}

async function readLibrary(dataDir) {
  let raw;
  try {
    raw = JSON.parse(await fsPromises.readFile(path.join(dataDir, 'books.json'), 'utf8'));
  } catch {
    throw new Error('Import bake-off could not read the library manifest');
  }
  return Array.isArray(raw) ? raw : Object.values(raw || {});
}

async function sourceFormat(filePath) {
  if (/\.xbook\.json$/i.test(filePath)) {
    const artifact = JSON.parse(await fsPromises.readFile(filePath, 'utf8'));
    return String(artifact?.sourceFormat || '').toLowerCase();
  }
  return path.extname(filePath).slice(1).toLowerCase();
}

async function librarySourceDigests(dataDir) {
  const books = await readLibrary(dataDir);
  const sources = [...new Set(books.flatMap(book => [
    book?.path,
    book?.sourcePath,
    book?.retainedSourcePath
  ]).map(value => String(value || '')).filter(Boolean))];
  const entries = [];
  for (let index = 0; index < sources.length; index += 1) {
    const sourcePath = sources[index];
    const available = await fsPromises.access(sourcePath).then(() => true, () => false);
    if (!available) continue;
    entries.push({
      digest: await sha256File(sourcePath, `library source ${index + 1}`),
      path: path.resolve(sourcePath)
    });
  }
  return new Map(entries.map(entry => [entry.digest, entry.path]));
}

async function buildHistoricalCases({ manifestPath, dataDir, libraryDigests }) {
  let manifest;
  try {
    manifest = JSON.parse(await fsPromises.readFile(manifestPath, 'utf8'));
  } catch {
    throw new Error('Import bake-off could not read the historical manifest');
  }
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest?.paths)) {
    throw new Error('Historical manifest must use schemaVersion 1 with a paths array');
  }
  if (manifest.paths.length !== 4) {
    throw new Error(`Historical manifest must contain exactly 4 paths; found ${manifest.paths.length}`);
  }
  const paths = manifest.paths.map(value => path.resolve(String(value || '')));
  if (new Set(paths).size !== 4) throw new Error('Historical manifest paths must be unique');
  if (paths.some(sourcePath => /\.xbook\.json$/i.test(sourcePath))) {
    throw new Error('Historical cases must use an original source file, not a processed XBook artifact');
  }

  const knownDigests = libraryDigests || await librarySourceDigests(dataDir);
  const cases = await Promise.all(paths.map(async (sourcePath, index) => {
    const digest = await sha256File(sourcePath, `historical source ${index + 1}`);
    if (!knownDigests.has(digest)) {
      throw new Error(`Historical source ${index + 1} is not an imported library source`);
    }
    let format;
    try {
      format = await sourceFormat(sourcePath);
    } catch {
      throw new Error(`Import bake-off could not inspect historical source ${index + 1}`);
    }
    if (!SUPPORTED_FORMATS.has(format)) {
      throw new Error(`Historical source ${index + 1} has unsupported format: ${format || 'unknown'}`);
    }
    return {
      id: `known:${index + 1}`,
      path: sourcePath,
      format,
      expectedImportable: true,
      digest
    };
  }));
  if (new Set(cases.map(value => value.digest)).size !== 4) {
    throw new Error('Historical manifest must identify four content-distinct books');
  }
  return cases;
}

async function downloadHoldoutCases({
  manifestPath,
  directory,
  libraryDigests,
  fetchImpl = fetch
}) {
  let manifest;
  try {
    manifest = JSON.parse(await fsPromises.readFile(manifestPath, 'utf8'));
  } catch {
    throw new Error('Import bake-off could not read the holdout manifest');
  }
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest?.sources)) {
    throw new Error('Holdout manifest must use schemaVersion 1 with a sources array');
  }
  if (manifest.sources.length !== 4) {
    throw new Error(`Holdout manifest must contain exactly 4 sources; found ${manifest.sources.length}`);
  }
  const urls = manifest.sources.map(source => String(source?.url || ''));
  if (new Set(urls).size !== 4) throw new Error('Holdout source URLs must be unique');
  await fsPromises.mkdir(directory, { recursive: true });
  const seenDigests = new Set();

  return Promise.all(manifest.sources.map(async (source, index) => {
    const url = new URL(String(source?.url || ''));
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new Error(`Holdout source ${index + 1} must use credential-free HTTPS`);
    }
    const filename = String(source?.filename || '');
    if (!filename || path.basename(filename) !== filename) {
      throw new Error(`Holdout source ${index + 1} has an unsafe filename`);
    }
    const format = String(source?.format || '').toLowerCase();
    if (!SUPPORTED_FORMATS.has(format)) {
      throw new Error(`Holdout source ${index + 1} has unsupported format: ${format || 'unknown'}`);
    }
    const expectedDigest = String(source?.sha256 || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expectedDigest)) {
      throw new Error(`Holdout source ${index + 1} requires a SHA-256 checksum`);
    }
    const minimumNormalizedChars = Number(source?.minimumNormalizedChars);
    if (!Number.isInteger(minimumNormalizedChars) || minimumNormalizedChars < 10000) {
      throw new Error(`Holdout source ${index + 1} requires a substantive minimum text length`);
    }
    const response = await fetchImpl(url.href, { redirect: 'follow' });
    if (!response?.ok) {
      throw new Error(`Holdout source ${index + 1} download failed with HTTP ${response?.status || 'unknown'}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (digest !== expectedDigest) {
      throw new Error(`Holdout source ${index + 1} checksum mismatch`);
    }
    if (libraryDigests?.has(digest)) {
      throw new Error(`Holdout source ${index + 1} is already present in the library`);
    }
    if (seenDigests.has(digest)) throw new Error('Holdout sources must contain four distinct books');
    seenDigests.add(digest);
    const destination = path.join(directory, filename);
    await fsPromises.writeFile(destination, bytes, { mode: 0o600 });
    return {
      id: `new:${index + 1}`,
      path: destination,
      format,
      expectedImportable: true,
      minimumNormalizedChars,
      digest
    };
  }));
}

module.exports = {
  buildHistoricalCases,
  downloadHoldoutCases,
  librarySourceDigests,
  sha256File,
  sourceFormat
};
