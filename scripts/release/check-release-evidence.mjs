#!/usr/bin/env node
/**
 * Lint the human-owned release matrix and, when requested by a release job,
 * refuse promotion until every blocking manual gate has concrete evidence.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const requirePassed = process.argv.includes('--require-passed');
const file = resolve(root, 'docs/RELEASE_TEST_MATRIX.md');
const text = readFileSync(file, 'utf8');
const expectedHeaders = [
  'ID', 'Scope', 'Release gate', 'Method and acceptance criteria',
  'Status', 'Evidence', 'Owner', 'Recorded',
];
const acceptedStatuses = new Set([
  'Pass', 'Fail', 'Blocked', 'Not run', 'Not applicable', 'Waived',
]);

function cells(line) {
  return line.trim().split('|').slice(1, -1).map(cell => cell.trim());
}

function fail(message) {
  throw new Error(`release evidence error: ${message}`);
}

const lines = text.split(/\r?\n/);
const headerIndex = lines.findIndex(line => line.startsWith('| ID | Scope |'));
if (headerIndex === -1) fail('RELEASE_TEST_MATRIX.md has no release-gate table');

const headers = cells(lines[headerIndex]);
if (headers.join('\u0000') !== expectedHeaders.join('\u0000')) {
  fail(`matrix headers must be: ${expectedHeaders.join(', ')}`);
}
if (!/^\|\s*---/.test(lines[headerIndex + 1] ?? '')) {
  fail('matrix header must have a Markdown separator row');
}

const rows = [];
for (const line of lines.slice(headerIndex + 2)) {
  if (!line.startsWith('|')) break;
  const row = cells(line);
  if (row.length !== expectedHeaders.length) fail(`malformed matrix row: ${line}`);
  rows.push(Object.fromEntries(headers.map((header, index) => [header, row[index]])));
}
if (!rows.length) fail('matrix has no gates');

const ids = new Set();
for (const row of rows) {
  if (!/^[A-Z]+-\d{2}$/.test(row.ID)) fail(`invalid gate ID: ${row.ID}`);
  if (ids.has(row.ID)) fail(`duplicate gate ID: ${row.ID}`);
  ids.add(row.ID);
  if (!['Blocking', 'Advisory'].includes(row.Scope)) fail(`${row.ID} has invalid scope`);
  if (!acceptedStatuses.has(row.Status)) fail(`${row.ID} has invalid status: ${row.Status}`);
  for (const column of ['Release gate', 'Method and acceptance criteria', 'Evidence', 'Owner', 'Recorded']) {
    if (!row[column] || row[column] === '—') fail(`${row.ID} is missing ${column}`);
  }
}

if (!requirePassed) {
  console.log(`Release evidence matrix is well-formed (${rows.length} gates).`);
  process.exit(0);
}

const firstRelease = rows.find(row => row.ID === 'FIRST-01');
const blockingFailures = rows.filter(row => {
  if (row.Scope !== 'Blocking') return false;
  if (row.Status === 'Pass') return false;
  return !(row.ID === 'DATA-02' && row.Status === 'Not applicable' && firstRelease?.Status === 'Pass');
});
if (blockingFailures.length) {
  fail(`blocking gates are not passed: ${blockingFailures.map(row => row.ID).join(', ')}`);
}

for (const row of rows.filter(row => row.Scope === 'Blocking')) {
  if (/\b(pending|required|manual evidence)\b/i.test(row.Evidence)) {
    fail(`${row.ID} is marked Pass but its evidence is still a placeholder`);
  }
  if (!/^\d{4}-\d{2}-\d{2}(?:[ T].*)?$/.test(row.Recorded)) {
    fail(`${row.ID} is marked Pass without an ISO-like recorded date`);
  }
}

const risks = readFileSync(resolve(root, 'docs/ACCEPTED_RISKS.md'), 'utf8');
if (/\|\s*R-\d+\s*\|[^\n]*\|\s*Open — release blocking\s*\|/.test(risks)) {
  fail('open release-blocking risks remain in docs/ACCEPTED_RISKS.md');
}

console.log(`All ${rows.filter(row => row.Scope === 'Blocking').length} blocking release-evidence gates passed.`);
