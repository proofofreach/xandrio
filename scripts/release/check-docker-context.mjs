#!/usr/bin/env node
/**
 * Fail release CI if the effective Docker build context contains operator data
 * or likely credentials. Unlike `git ls-files`, this walks the worktree so an
 * untracked file is checked exactly as Docker would receive it.
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

const rootArgument = process.argv.find(argument => argument.startsWith('--root='));
const root = resolve(rootArgument ? rootArgument.slice('--root='.length) : resolve(import.meta.dirname, '..', '..'));
const ignore = readFileSync(resolve(root, '.dockerignore'), 'utf8');
const requiredRules = [
  '.git', '.env', '.env.*', '.npmrc', 'data', 'cache', 'logs',
  'alexandrio-xandrio/data', 'tts-benchmark-samples', 'Test Books',
  'node_modules', 'kokoro-venv', 'chatterbox-venv', 'mlx-venv', '*-venv',
  '.claude', '.codex', '.clawpatch', '.playwright-cli', 'output',
  'nanobanana-output', '*.pem', '*.key',
  '*.mp3', '*.wav', '*.epub', '*.pdf', '*.mobi', '*.azw3'
];

for (const rule of requiredRules) {
  if (!ignore.split(/\r?\n/).includes(rule)) {
    throw new Error(`.dockerignore is missing required rule: ${rule}`);
  }
}

function normalizePath(file) {
  return file.split(sep).join('/').replace(/^\.\//, '');
}

function globPattern(pattern) {
  let expression = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        while (pattern[index + 1] === '*') index += 1;
        expression += '.*';
      } else {
        expression += '[^/]*';
      }
    } else if (character === '?') {
      expression += '[^/]';
    } else {
      expression += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return expression;
}

function dockerIgnoreMatcher(contents) {
  const rules = contents
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const include = line.startsWith('!');
      const raw = (include ? line.slice(1) : line).replace(/^\/+|\/+$/g, '');
      const expression = globPattern(raw);
      // Docker applies Go filepath.Match rules: without **, a pattern is
      // relative to the context root rather than a recursive basename match.
      return { include, expression: new RegExp(`^${expression}(?:/.*)?$`) };
    });

  return file => {
    let ignored = false;
    for (const rule of rules) {
      if (rule.expression.test(file)) ignored = !rule.include;
    }
    return ignored;
  };
}

function walk(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name);
    const file = normalizePath(relative(root, absolute));
    const stat = lstatSync(absolute);
    files.push({ absolute, file, stat });
    if (stat.isDirectory()) walk(absolute, files);
  }
  return files;
}

function isSensitivePath(file) {
  if (file === '.env.template') return false;
  // These are deliberate static fixtures used by the shipped TTS comparison
  // page. Asset provenance is checked separately; excluding them breaks it.
  if (/^public\/tts-params-ab\/p[12]_[ABC]\.mp3$/.test(file)) return false;
  const base = file.split('/').at(-1);
  return /(^|\/)(data|cache|logs|screenshots|test-results)\//.test(file) ||
    /(^|\/)\.env(?:\.|$)/.test(file) ||
    /\.(?:pem|key|crt|p12|pfx|kdbx|mp3|wav|m4a|flac|ogg|epub|pdf|mobi|prc|azw|azw3)$/i.test(file) ||
    /(?:^|[._-])(secret|token|credential|password|private)(?:[._-]|$)/i.test(base);
}

const ignored = dockerIgnoreMatcher(ignore);
const allFiles = walk(root);
const contextFiles = allFiles.filter(({ file, stat }) => !stat.isDirectory() && !ignored(file));
const unsafeContextFiles = contextFiles.filter(({ file }) => isSensitivePath(file));

const externalLinks = contextFiles.filter(({ absolute, file, stat }) => {
  if (!stat.isSymbolicLink()) return false;
  try {
    const target = realpathSync(absolute);
    return target !== root && !target.startsWith(`${root}${sep}`);
  } catch {
    return true;
  }
}).map(({ file }) => file);

if (unsafeContextFiles.length || externalLinks.length) {
  const problems = [
    ...unsafeContextFiles.map(({ file }) => `sensitive file: ${file}`),
    ...externalLinks.map(file => `symlink escapes build context: ${file}`)
  ];
  throw new Error(`Docker build context contains forbidden entries:\n${problems.join('\n')}`);
}

let tracked = [];
try {
  tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
} catch (error) {
  if (!rootArgument) throw error;
  // Fixture roots use the same context inspection without requiring Git.
}
const operatorData = tracked.filter(file => {
  if (file === '.env.template') return false; // reviewed configuration template, not a credential file
  if (file.startsWith('alexandrio-xandrio/data/')) return false; // covered by its explicit Docker deny rule
  if (file.startsWith('tts-benchmark-samples/')) return false; // calibration fixtures are separately release-gated
  return /(^|\/)(data|cache|logs|screenshots|test-results)\//.test(file) ||
    /(^|\/)\.env(?:\.|$)/.test(file) ||
    /\.(?:pem|key|crt|p12|pfx|kdbx|mp3|wav|m4a|flac|ogg|epub|pdf|mobi|prc|azw|azw3)$/i.test(file);
});

if (operatorData.length) {
  throw new Error(`Tracked operator data cannot be released: ${operatorData.join(', ')}`);
}

console.log(`Docker context policy passed: inspected ${contextFiles.length} effective context files, including untracked files.`);
