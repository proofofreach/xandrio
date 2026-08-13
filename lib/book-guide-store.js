'use strict';

const path = require('node:path');
const fsDefault = require('node:fs').promises;
const jsonStoreDefault = require('./json-store');
const { validateBookGuideArtifact } = require('./book-guide-validation');

const CONFIG_VERSION = 1;

function assertSafeBookId(bookId) {
  if (typeof bookId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(bookId)) {
    const error = new Error('Invalid book identifier');
    error.code = 'BOOK_GUIDE_INVALID_BOOK_ID';
    throw error;
  }
  return bookId;
}

function normalizeStoredConfig(value) {
  const config = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    version: CONFIG_VERSION,
    enabled: config.enabled === true,
    baseUrl: typeof config.baseUrl === 'string' ? config.baseUrl : '',
    generator: config.generator && typeof config.generator === 'object'
      ? { name: String(config.generator.name || ''), digest: String(config.generator.digest || '') }
      : null,
    verifier: config.verifier && typeof config.verifier === 'object'
      ? { name: String(config.verifier.name || ''), digest: String(config.verifier.digest || '') }
      : null,
    configuredAt: typeof config.configuredAt === 'string' ? config.configuredAt : null
  };
}

function createBookGuideStore({
  artifactDir,
  configFile,
  certificationFile = `${configFile}.certification.json`,
  fs = fsDefault,
  jsonStore = jsonStoreDefault,
  validateArtifact = validateBookGuideArtifact
} = {}) {
  if (!artifactDir || !configFile) throw new TypeError('artifactDir and configFile are required');
  const root = path.resolve(artifactDir);

  function artifactPath(bookId) {
    return path.join(root, `${assertSafeBookId(bookId)}.guide.json`);
  }

  async function read(bookId) {
    return jsonStore.load(artifactPath(bookId), null, { throwOnCorrupt: true });
  }

  async function publish(bookId, artifact, { snapshot = null } = {}) {
    assertSafeBookId(bookId);
    if (artifact?.bookId !== bookId) throw new TypeError('Artifact book id does not match');
    validateArtifact(artifact, { snapshot });
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await jsonStore.save(artifactPath(bookId), artifact);
    return artifact;
  }

  async function remove(bookId) {
    try {
      await fs.unlink(artifactPath(bookId));
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  async function loadConfig() {
    return normalizeStoredConfig(await jsonStore.load(configFile, { version: CONFIG_VERSION, enabled: false }));
  }

  async function loadCertification() {
    return jsonStore.load(certificationFile, null);
  }

  async function saveConfig(config) {
    const normalized = normalizeStoredConfig(config);
    await fs.mkdir(path.dirname(configFile), { recursive: true, mode: 0o700 });
    await jsonStore.save(configFile, normalized);
    return normalized;
  }

  async function clearConfig() {
    try {
      await fs.unlink(configFile);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  return {
    artifactPath,
    clearConfig,
    loadCertification,
    loadConfig,
    publish,
    read,
    remove,
    saveConfig
  };
}

module.exports = {
  CONFIG_VERSION,
  assertSafeBookId,
  createBookGuideStore,
  normalizeStoredConfig
};
