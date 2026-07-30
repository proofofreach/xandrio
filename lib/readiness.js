const fs = require('node:fs').promises;
const fsConstants = require('node:fs').constants;

function createReadinessProbe({
  dataDir,
  cacheDir,
  criticalJsonFiles = [],
  access = fs.access,
  readFile = fs.readFile
}) {
  const directories = [dataDir, cacheDir].filter(Boolean);
  const jsonFiles = [...new Set(criticalJsonFiles.filter(Boolean))];

  async function check() {
    try {
      await Promise.all(directories.map(directory =>
        access(directory, fsConstants.R_OK | fsConstants.W_OK)
      ));
      await Promise.all(jsonFiles.map(async filePath => {
        try {
          const source = await readFile(filePath, 'utf8');
          JSON.parse(source);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }));
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
