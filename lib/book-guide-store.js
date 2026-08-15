'use strict';

const path = require('node:path');
const fsDefault = require('node:fs').promises;
const jsonStoreDefault = require('./json-store');
const { validateBookGuideArtifact } = require('./book-guide-validation');

const CONFIG_VERSION = 1;
const WORK_VERSION = 1;

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
    allowUncertified: config.allowUncertified === true,
    externalProcessingAcknowledgedAt: typeof config.externalProcessingAcknowledgedAt === 'string'
      ? config.externalProcessingAcknowledgedAt
      : null,
    baseUrl: typeof config.baseUrl === 'string' ? config.baseUrl : '',
    provider: typeof config.provider === 'string' ? config.provider : '',
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
  credentialsFile = `${configFile}.credentials.json`,
  fs = fsDefault,
  jsonStore = jsonStoreDefault,
  validateArtifact = validateBookGuideArtifact
} = {}) {
  if (!artifactDir || !configFile) throw new TypeError('artifactDir and configFile are required');
  const root = path.resolve(artifactDir);
  const workRoot = path.join(root, '.work');

  function artifactPath(bookId) {
    return path.join(root, `${assertSafeBookId(bookId)}.guide.json`);
  }

  function workPath(bookId) {
    return path.join(workRoot, `${assertSafeBookId(bookId)}.work.json`);
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

  async function readWork(bookId) {
    return jsonStore.load(workPath(bookId), null, { throwOnCorrupt: true });
  }

  async function saveWork(bookId, work) {
    assertSafeBookId(bookId);
    if (!work || work.version !== WORK_VERSION || work.bookId !== bookId) {
      throw new TypeError('Invalid book guide work checkpoint');
    }
    await fs.mkdir(workRoot, { recursive: true, mode: 0o700 });
    await fs.chmod(workRoot, 0o700);
    await jsonStore.save(workPath(bookId), work);
    return work;
  }

  async function removeWork(bookId) {
    try {
      await fs.unlink(workPath(bookId));
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

  async function loadCredentials() {
    const value = await jsonStore.load(credentialsFile, {});
    return {
      apiKey: typeof value?.apiKey === 'string' ? value.apiKey : '',
      updatedAt: typeof value?.updatedAt === 'string' ? value.updatedAt : null
    };
  }

  async function saveCredentials({ apiKey, updatedAt }) {
    const normalizedKey = String(apiKey || '').trim();
    if (!normalizedKey || /[\u0000-\u001f\u007f]/.test(normalizedKey) || normalizedKey.length > 500) {
      const error = new Error('Invalid study-guide provider key');
      error.code = 'BOOK_GUIDE_PROVIDER_CREDENTIALS_INVALID';
      throw error;
    }
    await fs.mkdir(path.dirname(credentialsFile), { recursive: true, mode: 0o700 });
    await jsonStore.save(credentialsFile, { version: 1, apiKey: normalizedKey, updatedAt: String(updatedAt || '') });
    return { configured: true, updatedAt: String(updatedAt || '') };
  }

  async function clearCredentials() {
    try {
      await fs.unlink(credentialsFile);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
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
    clearCredentials,
    clearConfig,
    loadCertification,
    loadConfig,
    loadCredentials,
    publish,
    read,
    readWork,
    remove,
    removeWork,
    saveConfig,
    saveCredentials,
    saveWork,
    workPath
  };
}

module.exports = {
  CONFIG_VERSION,
  WORK_VERSION,
  assertSafeBookId,
  createBookGuideStore,
  normalizeStoredConfig
};
