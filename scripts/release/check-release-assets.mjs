#!/usr/bin/env node
/** Fail publication while the reviewed asset inventory has unresolved entries. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const inventory = readFileSync(resolve(root, 'docs', 'ASSET_PROVENANCE.md'), 'utf8');
const interFont = readFileSync(resolve(root, 'public', 'fonts', 'inter-latin.woff2'));
const interLicence = readFileSync(resolve(root, 'public', 'fonts', 'OFL.txt'), 'utf8');
const interHash = createHash('sha256').update(interFont).digest('hex');
const expectedInterHash = 'c940764593d0fe5d596be327ca7558855e018039fb78509aa21921fd3644c3e4';

if (interHash !== expectedInterHash) {
  throw new Error(`Inter font digest drifted: expected ${expectedInterHash}, received ${interHash}`);
}
if (!interLicence.includes('Copyright 2020 The Inter Project Authors') ||
    !interLicence.includes('SIL OPEN FONT LICENSE Version 1.1')) {
  throw new Error('The bundled Inter OFL 1.1 notice is missing or incomplete');
}
const unresolved = inventory.split(/\r?\n/)
  .filter(line => line.startsWith('| `') && line.includes('**Owner review required**'));

if (unresolved.length > 0) {
  throw new Error(`${unresolved.length} release asset entr${unresolved.length === 1 ? 'y requires' : 'ies require'} owner review; see docs/ASSET_PROVENANCE.md`);
}

console.log('Release asset provenance gate passed.');
