#!/usr/bin/env node
// Admin CLI for username/password accounts.
//
// Usage:
//   node scripts/manage-accounts.js add <username> [--admin] [--display-name "Name"] [--profile usr_xxx] [--absorb-default]
//   node scripts/manage-accounts.js passwd <username>
//   node scripts/manage-accounts.js disable <username>
//   node scripts/manage-accounts.js enable <username>
//   node scripts/manage-accounts.js list
//
// Respects DATA_DIR like the server; run with --env-file-if-exists=.env to
// pick up the same environment (npm start does this automatically):
//   node --env-file-if-exists=.env scripts/manage-accounts.js list
//
// --profile binds the new account to an existing sync-profile id from
// users.json so its positions/bookmarks/settings attach without migration.
// --absorb-default merges the legacy shared "default" user's data into the
// new account (existing account data wins on conflicts).

const path = require('path');
const readline = require('readline');
const jsonStore = require('../lib/json-store');
const { createAccountsStore, normalizeUsername } = require('../lib/accounts');
const { createSessionStore } = require('../lib/auth');
const { createUserLibraryState } = require('../lib/user-library-state');
const shelves = require('../lib/shelves');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const POSITIONS_FILE = path.join(DATA_DIR, 'positions.json');
const BOOKMARKS_FILE = path.join(DATA_DIR, 'bookmarks.json');
const CLIENT_SETTINGS_FILE = path.join(DATA_DIR, 'client-settings.json');
const SHELVES_FILE = path.join(DATA_DIR, 'shelves.json');

const MIN_PASSWORD_LENGTH = 8;

const accounts = createAccountsStore({ filePath: ACCOUNTS_FILE, jsonStore });
const sessions = createSessionStore({ filePath: SESSIONS_FILE, jsonStore });
const userLibraryState = createUserLibraryState();

function usage(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error('Usage:');
  console.error('  manage-accounts.js add <username> [--admin] [--display-name "Name"] [--profile usr_xxx] [--absorb-default]');
  console.error('  manage-accounts.js passwd <username>');
  console.error('  manage-accounts.js disable <username> | enable <username>');
  console.error('  manage-accounts.js list');
  process.exit(1);
}

function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = rl._writeToOutput.bind(rl);
    rl.question(question, (answer) => {
      rl._writeToOutput = write;
      process.stdout.write('\n');
      rl.close();
      resolve(answer);
    });
    // Mask typed characters after the prompt itself has been printed.
    rl._writeToOutput = (chunk) => {
      if (chunk.includes(question)) write(question);
    };
    rl.on('error', reject);
  });
}

async function promptNewPassword() {
  if (!process.stdin.isTTY) {
    // Non-interactive callers pass the password via environment to keep it
    // out of argv and shell history.
    const fromEnv = process.env.XANDRIO_NEW_PASSWORD;
    if (!fromEnv) usage('No TTY available; set XANDRIO_NEW_PASSWORD for non-interactive use');
    return fromEnv;
  }
  const password = await promptHidden('New password: ');
  if (password.length < MIN_PASSWORD_LENGTH) usage(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  const confirmation = await promptHidden('Repeat password: ');
  if (password !== confirmation) usage('Passwords do not match');
  return password;
}

async function requireAccount(username) {
  const account = await accounts.findByUsername(username);
  if (!account) usage(`No account with username: ${username}`);
  return account;
}

async function absorbDefaultInto(userId) {
  const from = userLibraryState.DEFAULT_USER_ID;
  await jsonStore.update(POSITIONS_FILE, (data) => {
    userLibraryState.migratePositions(data, from, userId);
  });
  for (const file of [BOOKMARKS_FILE, CLIENT_SETTINGS_FILE, SHELVES_FILE]) {
    await jsonStore.update(file, (data) => {
      userLibraryState.migrateUserScopedStore(data, from, userId);
    });
  }
  console.log(`Merged "${from}" user data into ${userId} (existing account data preserved on conflicts).`);
}

async function cmdAdd(username, flags) {
  if (!normalizeUsername(username)) usage('Username must be 2-32 characters: lowercase letters, digits, _ or -');
  if (await accounts.findByUsername(username)) usage(`Username already exists: ${username}`);

  let profileId = null;
  if (flags.profile) {
    profileId = userLibraryState.sanitizeSyncId(flags.profile, '');
    if (!profileId) usage(`Invalid profile id: ${flags.profile}`);
    const users = await jsonStore.load(USERS_FILE, {});
    if (!users.users?.[profileId]) {
      console.warn(`Warning: ${profileId} has no sync profile in users.json; binding anyway.`);
    }
  }

  const password = await promptNewPassword();
  const account = await accounts.createAccount({
    username,
    password,
    displayName: flags.displayName,
    role: flags.admin ? 'admin' : 'member',
    id: profileId
  });
  console.log(`Created ${account.role} account "${account.username}" (${account.id}).`);
  if (flags.absorbDefault) await absorbDefaultInto(account.id);
  await seedShelf(account.id);
}

// Start the shelf with every book the user already has progress in.
async function seedShelf(userId) {
  const positions = userLibraryState.positionsForUser(await jsonStore.load(POSITIONS_FILE, {}), userId);
  const bookIds = Object.keys(positions);
  if (!bookIds.length) return;
  await jsonStore.update(SHELVES_FILE, (data) => {
    shelves.seedShelfFromPositions(data, userId, positions);
  });
  console.log(`Seeded shelf with ${bookIds.length} book(s) from existing reading progress.`);
}

async function cmdPasswd(username) {
  const account = await requireAccount(username);
  const password = await promptNewPassword();
  await accounts.changePassword(account.id, password);
  await sessions.destroyAllForUser(account.id);
  console.log(`Password updated for "${account.username}"; all sessions revoked.`);
}

async function cmdSetDisabled(username, disabled) {
  const account = await requireAccount(username);
  await accounts.setDisabled(account.id, disabled);
  if (disabled) await sessions.destroyAllForUser(account.id);
  console.log(`Account "${account.username}" ${disabled ? 'disabled; all sessions revoked' : 'enabled'}.`);
}

async function cmdList() {
  const list = await accounts.list();
  if (list.length === 0) {
    console.log('No accounts. The instance runs in shared-token or trusted-LAN mode.');
    return;
  }
  for (const account of list) {
    const status = account.disabled ? ' [disabled]' : '';
    console.log(`${account.username}  role=${account.role}  id=${account.id}${status}`);
  }
}

function parseFlags(args) {
  const flags = { admin: false, absorbDefault: false, profile: null, displayName: null };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--admin') flags.admin = true;
    else if (arg === '--absorb-default') flags.absorbDefault = true;
    else if (arg === '--profile') flags.profile = args[++i];
    else if (arg === '--display-name') flags.displayName = args[++i];
    else if (arg.startsWith('--')) usage(`Unknown flag: ${arg}`);
    else positional.push(arg);
  }
  return { flags, positional };
}

(async () => {
  const [command, ...rest] = process.argv.slice(2);
  const { flags, positional } = parseFlags(rest);
  const username = positional[0];

  switch (command) {
    case 'add':
      if (!username) usage('add requires a username');
      await cmdAdd(username, flags);
      break;
    case 'passwd':
      if (!username) usage('passwd requires a username');
      await cmdPasswd(username);
      break;
    case 'disable':
      if (!username) usage('disable requires a username');
      await cmdSetDisabled(username, true);
      break;
    case 'enable':
      if (!username) usage('enable requires a username');
      await cmdSetDisabled(username, false);
      break;
    case 'list':
      await cmdList();
      break;
    default:
      usage(command ? `Unknown command: ${command}` : null);
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
