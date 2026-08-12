const assert = require('assert');
const { proveArtifactRecovery } = require('../lib/extraction-recovery');

const accepted = [
  { title: 'One', text: 'First retained paragraph. '.repeat(40) },
  { title: 'Two', text: 'Second retained paragraph. '.repeat(40) }
];

(async () => {
  const equivalent = await proveArtifactRecovery({
    sourceFormat: 'PDF',
    acceptedChapters: accepted,
    sourceDocument: { pages: [{ pageNumber: 1, text: 'source' }] },
    rebuildPdf: async () => accepted.map(chapter => ({ ...chapter }))
  });
  assert(equivalent.proven && equivalent.reason === 'round-trip-equivalent',
    'proves recovery only when rebuilt narration is equivalent');

  const lossy = await proveArtifactRecovery({
    sourceFormat: 'PDF',
    acceptedChapters: accepted,
    sourceDocument: { pages: [{ pageNumber: 1, text: 'source' }] },
    rebuildPdf: async () => [{ title: 'One', text: accepted[0].text }]
  });
  assert(!lossy.proven && lossy.reason === 'round-trip-text-mismatch',
    'retains the source when a recovery round trip loses text');

  const normalizedButNotExact = await proveArtifactRecovery({
    sourceFormat: 'PDF',
    acceptedChapters: [{ title: 'One', text: 'A  B' }],
    sourceDocument: { pages: [{ pageNumber: 1, text: 'source' }] },
    rebuildPdf: async () => [{ title: 'One', text: 'A B' }]
  });
  assert(!normalizedButNotExact.proven && normalizedButNotExact.reason === 'round-trip-text-mismatch',
    'normalization-equivalent text is not sufficient proof for source deletion');

  const kindle = await proveArtifactRecovery({
    sourceFormat: 'AZW3',
    acceptedChapters: accepted
  });
  assert(!kindle.proven && kindle.reason === 'recovery-data-unavailable',
    'retains formats without sufficient stored recovery data');

  console.log('4 passed, 0 failed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
