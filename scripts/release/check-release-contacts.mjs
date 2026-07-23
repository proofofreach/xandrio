#!/usr/bin/env node
/** Verify published contact addresses are consistent and have routable mail DNS. */
import { resolveMx } from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const contacts = [
  { address: 'security@xandrio.xyz', file: 'SECURITY.md' },
  { address: 'conduct@xandrio.xyz', file: 'CODE_OF_CONDUCT.md' }
];

function fail(message) {
  console.error(`release contact error: ${message}`);
  process.exitCode = 1;
}

for (const { address, file } of contacts) {
  const contents = readFileSync(resolve(root, file), 'utf8');
  if (!contents.includes(address)) fail(`${file} does not publish ${address}`);
}

for (const domain of new Set(contacts.map(({ address }) => address.split('@')[1]))) {
  try {
    const records = await resolveMx(domain);
    if (!records.some(record => record.exchange && record.exchange !== '.')) {
      fail(`${domain} has no usable MX record`);
    } else {
      console.log(`${domain} has ${records.length} MX record${records.length === 1 ? '' : 's'}.`);
    }
  } catch (error) {
    fail(`${domain} mail DNS lookup failed: ${error.code || error.message}`);
  }
}

if (!process.exitCode) {
  console.log('Published release contact DNS passed. Manual mailbox delivery tests are still required.');
}
