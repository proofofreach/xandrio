const assert = require('node:assert/strict');
const { prepareTtsText } = require('../lib/tts-text');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL ${name}: ${error.message}`);
  }
}

test('expands numeric ordinals before narration reaches a TTS engine', () => {
  assert.equal(
    prepareTtsText('The hearing was held on the 22nd of May.'),
    'The hearing was held on the twenty-second of May.'
  );
});

test('expands irregular and compound ordinal endings', () => {
  assert.equal(
    prepareTtsText('The 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st, 23rd, and 31st entries.'),
    'The first, second, third, fourth, eleventh, twelfth, thirteenth, twenty-first, twenty-third, and thirty-first entries.'
  );
});

test('expands larger ordinals and comma-grouped source numbers', () => {
  assert.equal(
    prepareTtsText('Milestones were the 100th, 101st, 1,000th, and 1,001st.'),
    'Milestones were the one hundredth, one hundred first, one thousandth, and one thousand first.'
  );
});

test('preserves malformed ordinal suffixes instead of changing their meaning', () => {
  assert.equal(
    prepareTtsText('References 11st, 12nd, and 13rd are source errors.'),
    'References 11st, 12nd, and 13rd are source errors.'
  );
});

console.log(`tts-text tests: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
