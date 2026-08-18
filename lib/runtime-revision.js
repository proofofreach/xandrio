/**
 * Which revision is this process actually running?
 *
 * The production deploy stages every release in an immutable directory stamped
 * with the exact revision it contains, so the running code can name itself by
 * reading its own directory. That stays correct after a rollback, when a value
 * baked into the service unit or the environment would still name the release
 * that just failed. The local supervisor has no release directory and passes
 * the revision in the environment instead.
 */
const fs = require('fs');
const path = require('path');

const REVISION_PATTERN = /^[0-9a-f]{40}$/;

function readStampedRevision(root, readFile = fs.readFileSync) {
  if (!root) return null;
  try {
    const stamped = String(readFile(path.join(root, '.xandrio-revision'), 'utf8')).trim();
    return REVISION_PATTERN.test(stamped) ? stamped : null;
  } catch {
    return null;
  }
}

function resolveRuntimeRevision({ root, env = process.env, readFile } = {}) {
  const supervised = String(env.XANDRIO_RUNTIME_REVISION || '').trim();
  if (supervised) return supervised;
  return readStampedRevision(root, readFile);
}

module.exports = { resolveRuntimeRevision, readStampedRevision, REVISION_PATTERN };
