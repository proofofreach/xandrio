// Startup and readiness checks for what the process needs from its host:
// a Node.js version inside package.json's engines range, and the ffmpeg and
// ffprobe binaries every audio path shells out to. Without these the server
// started fine and failed on the first chapter, long after the deploy had
// passed /ready. Probing is done once at startup and cached; /ready reports
// the cached verdict so it stays cheap.
const { execFile: execFileDefault } = require('node:child_process');

const REQUIRED_BINARIES = ['ffmpeg', 'ffprobe'];

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value || '').trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersions(a, b) {
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

// Supports the comparator set npm's engines field uses in practice:
// whitespace-separated `>=`, `>`, `<=`, `<`, `=` (or bare) versions, all of
// which must hold. Anything else is reported as unparseable rather than
// guessed at.
function parseRange(range) {
  const comparators = [];
  for (const token of String(range || '').trim().split(/\s+/).filter(Boolean)) {
    const match = /^(>=|<=|>|<|=)?v?(\d+(?:\.\d+){0,2})$/.exec(token);
    if (!match) return null;
    const parts = match[2].split('.').map(Number);
    while (parts.length < 3) parts.push(0);
    comparators.push({ operator: match[1] || '=', version: parts });
  }
  return comparators.length ? comparators : null;
}

function checkNodeVersion({ version = process.version, engines = {} } = {}) {
  const current = parseVersion(version);
  const range = engines?.node;
  if (!range) return { ok: true, tooOld: false, satisfied: true, detail: 'no engines.node requirement' };
  const comparators = parseRange(range);
  if (!current || !comparators) {
    return { ok: true, tooOld: false, satisfied: true, detail: `could not interpret engines.node ${JSON.stringify(range)}` };
  }
  let tooOld = false;
  let satisfied = true;
  for (const { operator, version: bound } of comparators) {
    const order = compareVersions(current, bound);
    const holds = operator === '>=' ? order >= 0
      : operator === '>' ? order > 0
      : operator === '<=' ? order <= 0
      : operator === '<' ? order < 0
      : order === 0;
    if (!holds) {
      satisfied = false;
      if (operator === '>=' || operator === '>') tooOld = true;
    }
  }
  const detail = satisfied
    ? `Node.js ${version} satisfies engines.node ${range}`
    : `Node.js ${version} is ${tooOld ? 'older than' : 'outside'} engines.node ${range}`;
  // Too old is a hard failure: APIs the code relies on are missing. Newer than
  // the declared range is a warning; the range caps what was tested, not what
  // runs.
  return { ok: !tooOld, tooOld, satisfied, detail };
}

function probeBinary(name, { execFile = execFileDefault, timeoutMs = 5000 } = {}) {
  return new Promise(resolve => {
    try {
      execFile(name, ['-version'], { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        if (error) {
          resolve({ name, ok: false, detail: error.code === 'ENOENT' ? `${name} is not installed or not on PATH` : `${name} -version failed: ${error.message}` });
          return;
        }
        const firstLine = String(stdout || '').split('\n')[0].trim();
        resolve({ name, ok: true, detail: firstLine || `${name} responded` });
      });
    } catch (error) {
      resolve({ name, ok: false, detail: `${name} could not be started: ${error.message}` });
    }
  });
}

function createRuntimeDependencyCheck({
  engines = {},
  version = process.version,
  binaries = REQUIRED_BINARIES,
  execFile = execFileDefault,
  log = console
} = {}) {
  let cached = null;

  async function run() {
    const node = checkNodeVersion({ version, engines });
    const probes = await Promise.all(binaries.map(name => probeBinary(name, { execFile })));
    const failures = [];
    const warnings = [];
    if (!node.ok) failures.push(node.detail);
    else if (!node.satisfied) warnings.push(node.detail);
    for (const probe of probes) {
      if (!probe.ok) failures.push(probe.detail);
    }
    return { ok: failures.length === 0, failures, warnings, node, binaries: probes };
  }

  return {
    // Resolves once; later calls return the cached verdict until refresh().
    check() {
      if (!cached) {
        cached = run().then(result => {
          for (const warning of result.warnings) log.warn(`[runtime] ${warning}`);
          for (const failure of result.failures) log.error(`[runtime] ${failure}`);
          return result;
        });
      }
      return cached;
    },
    refresh() {
      cached = null;
      return this.check();
    }
  };
}

module.exports = { REQUIRED_BINARIES, checkNodeVersion, createRuntimeDependencyCheck, parseRange, parseVersion, probeBinary };
