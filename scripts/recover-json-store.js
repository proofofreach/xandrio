#!/usr/bin/env node

// Inspect and restore recovery copies created by lib/json-store.
//
// Restore is intentionally two-step: inspect with `list`, then pass --yes to
// replace the store. The displaced bytes are retained as a bounded backup.

const path = require('path');
const jsonStore = require('../lib/json-store');

function usage(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error('Usage:');
  console.error('  recover-json-store.js list <store.json> [--type object|array|any] [--required-key KEY]');
  console.error('  recover-json-store.js restore <store.json> <candidate> --yes [--type object|array|any] [--required-key KEY] [--max-backups N]');
  process.exitCode = 1;
}

function parseArgs(args) {
  const options = {
    type: 'object',
    requiredKeys: [],
    maxBackups: 5,
    yes: false
  };
  const positional = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--yes') {
      options.yes = true;
    } else if (arg === '--type') {
      options.type = args[++index];
    } else if (arg === '--required-key') {
      options.requiredKeys.push(args[++index]);
    } else if (arg === '--max-backups') {
      options.maxBackups = Number(args[++index]);
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (!['object', 'array', 'any'].includes(options.type)) {
    throw new Error('--type must be object, array, or any');
  }
  if (options.requiredKeys.some(key => !key)) {
    throw new Error('--required-key needs a value');
  }
  if (!Number.isInteger(options.maxBackups) || options.maxBackups < 1 || options.maxBackups > 100) {
    throw new Error('--max-backups must be an integer from 1 to 100');
  }
  return { positional, options };
}

function createValidator({ type, requiredKeys }) {
  return (data) => {
    if (type === 'object' && (data === null || typeof data !== 'object' || Array.isArray(data))) {
      return 'top level must be an object';
    }
    if (type === 'array' && !Array.isArray(data)) {
      return 'top level must be an array';
    }
    if (requiredKeys.length) {
      if (data === null || typeof data !== 'object' || Array.isArray(data)) {
        return 'required keys need an object at the top level';
      }
      const missing = requiredKeys.filter(key => !Object.prototype.hasOwnProperty.call(data, key));
      if (missing.length) return `missing required key(s): ${missing.join(', ')}`;
    }
    return true;
  };
}

async function list(storePath, validate) {
  const candidates = await jsonStore.listRecoveryCandidates(storePath, { validate });
  if (!candidates.length) {
    console.log(`No recovery copies found for ${storePath}`);
    return candidates;
  }
  for (const candidate of candidates) {
    const status = candidate.valid ? 'valid' : `INVALID (${candidate.error})`;
    console.log(`${status}\t${candidate.kind}\t${candidate.mtime}\t${candidate.size ?? '-'} bytes\t${candidate.path}`);
  }
  return candidates;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  let parsed;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    usage(error.message);
    return;
  }
  const { positional, options } = parsed;
  const storeArg = positional[0];
  if (!command || !storeArg) {
    usage();
    return;
  }

  const storePath = path.resolve(storeArg);
  const validate = createValidator(options);
  if (command === 'list') {
    if (positional.length !== 1) {
      usage('list accepts one store path');
      return;
    }
    await list(storePath, validate);
    return;
  }
  if (command !== 'restore') {
    usage(`Unknown command: ${command}`);
    return;
  }
  if (positional.length !== 2) {
    usage('restore needs a store path and recovery candidate');
    return;
  }

  const candidatePath = path.resolve(positional[1]);
  const candidates = await list(storePath, validate);
  const selected = candidates.find(candidate => candidate.path === candidatePath);
  if (!selected) throw new Error('The selected path is not a recovery copy for this store');
  if (!selected.valid) throw new Error('The selected recovery copy does not pass validation');
  if (!options.yes) {
    console.error('\nNo changes made. Re-run the restore command with --yes after reviewing the candidate.');
    process.exitCode = 2;
    return;
  }

  const result = await jsonStore.restoreRecoveryCandidate(storePath, candidatePath, {
    validate,
    maxBackups: options.maxBackups
  });
  console.log(`Restored ${storePath} from ${result.restoredFrom}`);
  if (result.preservedCurrent) {
    console.log(`The displaced store was preserved in ${storePath}.backups`);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
