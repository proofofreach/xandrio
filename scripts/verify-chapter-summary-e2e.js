'use strict';
// Failure cases were recorded before implementation in the repair manifest:
// bounds, private fields/text disclosure, stale labels and mutation/reparsing.
// Drive the real server endpoint using only temporary synthetic artifacts.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { startScenarioEnvironment } = require('../test/fixtures/scenarios/lib/environment');
const output = path.resolve(__dirname, '../output/ui-rewrite-fixes/chapter-summary.json');

(async () => {
  let environment;
  const report = { passed: false, checks: [] };
  try {
    let tracked;
    environment = await startScenarioEnvironment({ proxyPort: 0, datasets: ['full'], prepareDataset: async ({ dataDir, cacheDir }) => {
      const file = path.join(dataDir, 'books.json');
      const books = JSON.parse(await fs.readFile(file, 'utf8'));
      books['scn-driftwood'].chapterStructureKey = 'stale-structure-key';
      await fs.writeFile(file, JSON.stringify(books));
      tracked = [file, path.join(dataDir, 'positions.json'), ...Object.keys(books).map(id => path.join(cacheDir, `${id}.xbook.json`))];
    } });
    const before = await Promise.all(tracked.map(async file => ({ file, text: await fs.readFile(file, 'utf8'), mtimeMs: (await fs.stat(file)).mtimeMs })));
    async function check(name, fn) {
      try { const evidence = await fn(); report.checks.push({ name, passed: true, evidence }); console.log(`PASS ${name}`); }
      catch (error) { report.checks.push({ name, passed: false, error: error.message }); console.log(`FAIL ${name}: ${error.message}`); }
    }
    const get = ids => fetch(`${environment.origin}/api/library/chapter-labels?bookIds=${encodeURIComponent(ids)}`);
    await check('only requested safe chapter descriptors are returned', async () => {
      const response = await get('scn-meridian,scn-lighthouse'); assert.equal(response.status, 200);
      const data = await response.json(); assert.deepEqual(Object.keys(data.summaries).sort(), ['scn-lighthouse', 'scn-meridian']);
      for (const summary of Object.values(data.summaries)) {
        assert.equal(typeof summary.structureKey, 'string'); assert(summary.chapters.length > 0);
        for (const chapter of summary.chapters) assert.deepEqual(Object.keys(chapter).sort(), ['empty', 'title', 'type']);
      }
      assert(!JSON.stringify(data).includes(environment.workDir), 'private path leaked'); return data;
    });
    await check('unknown and stale structures fail closed', async () => {
      const response = await get('scn-driftwood,not_a_book'); assert.equal(response.status, 200);
      const data = await response.json(); assert.deepEqual(data.summaries, { 'scn-driftwood': null, not_a_book: null }); return data;
    });
    await check('empty invalid and over-50 requests are rejected', async () => {
      const statuses = [];
      for (const ids of ['', '../private', Array.from({ length: 51 }, (_, index) => `id_${index}`).join(',')]) {
        const response = await get(ids); statuses.push(response.status); assert.equal(response.status, 400);
      }
      return { statuses };
    });
    await check('duplicate identifiers cause one response descriptor', async () => {
      const data = await (await get('scn-meridian,scn-meridian')).json(); assert.deepEqual(Object.keys(data.summaries), ['scn-meridian']); return { ids: Object.keys(data.summaries) };
    });
    await check('repeated summary reads preserve artifacts and position state', async () => {
      for (let i = 0; i < 4; i++) { const response = await get('scn-meridian,scn-lighthouse,scn-fieldnotes'); assert.equal(response.status, 200); await response.json(); }
      const after = await Promise.all(tracked.map(async file => ({ file, text: await fs.readFile(file, 'utf8'), mtimeMs: (await fs.stat(file)).mtimeMs })));
      assert.deepEqual(after, before, 'chapter summary reads mutated persisted books, chapters or positions');
      return { unchanged: tracked.map(file => path.basename(file)), requests: 4 };
    });
    report.passed = report.checks.every(check => check.passed);
  } catch (error) { report.error = error.stack; }
  finally { await environment?.close(); await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, JSON.stringify(report, null, 2)); process.exitCode = report.passed ? 0 : 1; }
})();
