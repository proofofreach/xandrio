#!/usr/bin/env node
/** Fail publication until every external owner/reviewer gate is recorded. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const approvals = readFileSync(resolve(root, 'docs', 'RELEASE_APPROVALS.md'), 'utf8');
const pending = approvals.split(/\r?\n/).filter(line => /^- \[ \]/.test(line));
const placeholderEvidence = approvals.split(/\r?\n/)
  .filter(line => /^- \[x\]/i.test(line) && /Evidence:\s*pending\.?$/i.test(line));

if (pending.length || placeholderEvidence.length) {
  throw new Error(`${pending.length + placeholderEvidence.length} release approval gate(s) remain unresolved; see docs/RELEASE_APPROVALS.md`);
}

console.log('Release approval gate passed.');
