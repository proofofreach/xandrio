const assert = require('node:assert/strict');
const { classifyImportOutcome } = require('../scripts/lib/import-benchmark-ux');

assert.equal(classifyImportOutcome({ playerOpen: true, openBookAction: false }), 0);
assert.equal(classifyImportOutcome({ playerOpen: false, openBookAction: true }), 1);
assert.equal(classifyImportOutcome({ playerOpen: false, openBookAction: false }), 2);

console.log('3 passed, 0 failed');
