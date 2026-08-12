const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'views', 'search.js'),
  'utf8'
);

assert(
  !source.includes('No specific warning details were returned.'),
  'an import review with no warning details must not invent an empty-warning message'
);

console.log('1 passed, 0 failed');
