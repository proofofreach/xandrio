const fs = require('node:fs').promises;
const fsConstants = require('node:fs').constants;

async function defaultExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

// Sibling marker written by lib/json-store.js critical stores once a file has
// held real data. Its presence turns a missing data file from "not set up yet"
// into "went missing after initialization".
function defaultMarkerPath(filePath) {
  return `${filePath}.initialized`;
}

function createReadinessProbe({
  dataDir,
  cacheDir,
  criticalJsonFiles = [],
  // When true (production), a data directory in which no critical store has
  // ever been initialized is reported not ready: that is what a wrong or empty
  // DATA_DIR looks like, and serving from it would silently start a new,
  // empty library (and, without accounts, a trusted-LAN admin for everyone).
  requireInitialized = false,
  // Optional async () => ({ ok, failures }) from lib/runtime-dependencies.js.
  dependencies = null,
  access = fs.access,
  readFile = fs.readFile,
  exists = defaultExists,
  markerPath = defaultMarkerPath
}) {
  const directories = [dataDir, cacheDir].filter(Boolean);
  // Entries are a path or { filePath, validate }; a validator lets readiness
  // reject a parseable file that the store itself would refuse to read.
  const byPath = new Map();
  for (const entry of criticalJsonFiles.filter(Boolean)) {
    const filePath = typeof entry === 'string' ? entry : entry.filePath;
    if (!filePath) continue;
    const validate = typeof entry === 'string' ? null : entry.validate || null;
    if (!byPath.has(filePath) || validate) byPath.set(filePath, validate);
  }
  const jsonFiles = [...byPath.keys()];

  function failure(code) {
    const error = new Error(code);
    error.code = code;
    return error;
  }

  async function check() {
    try {
      await Promise.all(directories.map(directory =>
        access(directory, fsConstants.R_OK | fsConstants.W_OK)
      ));
      let initialized = false;
      await Promise.all(jsonFiles.map(async filePath => {
        try {
          const source = await readFile(filePath, 'utf8');
          const data = JSON.parse(source);
          const validate = byPath.get(filePath);
          if (validate) {
            const verdict = validate(data);
            if (verdict === false || (typeof verdict === 'string' && verdict)) {
              throw failure('JSON_STORE_VALIDATION_FAILED');
            }
          }
          initialized = true;
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
          // A store that was initialized and is now missing is corruption the
          // critical store itself refuses to paper over; so does readiness.
          if (await exists(markerPath(filePath))) throw failure('JSON_STORE_MISSING_AFTER_INIT');
        }
      }));
      if (requireInitialized && !initialized) {
        const markers = await Promise.all(jsonFiles.map(filePath => exists(markerPath(filePath))));
        if (!markers.some(Boolean)) throw failure('DATA_DIR_NOT_INITIALIZED');
      }
      if (dependencies) {
        const verdict = await dependencies();
        if (!verdict?.ok) throw failure('RUNTIME_DEPENDENCY_MISSING');
      }
      return { ready: true };
    } catch (error) {
      return {
        ready: false,
        reason: error?.code || error?.name || 'READINESS_CHECK_FAILED'
      };
    }
  }

  return { check };
}

module.exports = { createReadinessProbe };
