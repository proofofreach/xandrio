// Failure modes: oversized import rewrites citation abbreviations, ordinals,
// currency, or casing; partition boundaries lose prose; chapter metadata is
// lost; short chapters change; moving substitutions breaks speech preparation.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createSyntheticImportEpub } = require('./lib/import-benchmark-fixtures');
const { extractChapters } = require('../lib/chapter-extraction');
const { createBookDocument } = require('../lib/book-document');
const { normalizedNarrationText } = require('../lib/extraction-result');
const { planNarration } = require('../lib/tts-text');

(async () => {
  const output = path.resolve(__dirname, '../output/playback-processing');
  await fs.mkdir(output, { recursive: true });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-source-partition-'));
  const evidence = { passed: false, sourceKind: 'synthetic', cases: [] };
  const digest = text => crypto.createHash('sha256').update(text).digest('hex');
  try {
    const epub = await createSyntheticImportEpub(temp);
    const paragraph = 'Journal 20, no. 8 (2010): 1–9. The 21st runner saved $12.50 while JOYCE watched. ';
    await fs.writeFile(path.join(temp, 'epub-source/OEBPS/chapter-1.xhtml'),
      `<html><body><h1>Chapter 1</h1>${Array.from({ length: 2400 }, () => `<p>${paragraph}</p>`).join('\n')}</body></html>`);
    execFileSync('zip', ['-q', epub, 'OEBPS/chapter-1.xhtml'], { cwd: path.join(temp, 'epub-source') });
    const source = await extractChapters(epub);
    const imported = await createBookDocument().extractChapters(epub);
    const before = normalizedNarrationText(source);
    const after = normalizedNarrationText(imported);
    const parts = imported.filter(chapter => chapter.splitFromOversizedChapter);
    evidence.cases.push({ name: 'oversized EPUB source conservation', sourceChapters: source.length,
      importedChapters: imported.length, splitParts: parts.length, sourceChars: before.length,
      importedChars: after.length, sourceHash: digest(before), importedHash: digest(after) });
    assert(parts.length > 1, 'the synthetic EPUB import must partition its oversized chapter');
    assert(parts.every(part => part.text.length <= 100000), 'all parts must fit the import chapter limit');
    assert.equal((after.match(/no\. 8/g) || []).length, 2400, 'partitioning must retain source citation abbreviations');
    assert.equal((after.match(/21st/g) || []).length, 2400, 'partitioning must retain source ordinals');
    assert.equal((after.match(/\$12\.50/g) || []).length, 2400, 'partitioning must retain source currency');
    assert.equal((after.match(/JOYCE/g) || []).length, 2400, 'partitioning must retain source casing');
    assert(before === after, 'partitioned EPUB text must conserve normalized source text at every boundary');
    assert(parts.every((part, index) => part.sourceTitle === 'Chapter 1' && part.splitPart === index + 1 &&
      part.splitPartCount === parts.length), 'each part must retain authored chapter metadata');
    for (const original of source.slice(1)) {
      const retained = imported.find(chapter => chapter.title === original.title);
      assert(retained && retained.text === original.text, 'ordinary chapters must retain their text');
    }
    evidence.cases.push({ name: 'chapter metadata and ordinary source text', passed: true });
    const narration = planNarration(paragraph, { maxChars: 120 });
    assert(narration.text.includes('twenty-first'), 'speech must still expand ordinal numbers');
    assert(narration.text.includes('twelve dollars and fifty cents'), 'speech must still pronounce currency');
    assert(narration.text.includes('Joyce'), 'speech must still normalize lexical all-caps words');
    assert(narration.chunks.length > 0, 'speech preparation must still produce playable chunks');
    evidence.cases.push({ name: 'speech substitutions remain at narration', passed: true });
    evidence.passed = true;
    console.log('PASS synthetic oversized EPUB import preserves citations, source text, metadata, and narration preparation');
  } finally {
    await fs.writeFile(path.join(output, `${process.env.SOURCE_PARTITION_PHASE || 'source-partition'}.json`), JSON.stringify(evidence, null, 2));
    await fs.rm(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
