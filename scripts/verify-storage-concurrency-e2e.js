'use strict';

// Failure modes recorded before implementation: a process pauses while writing
// its lock owner; another process treats that live empty lock as stale and both
// overwrite the same state. Two stale-lock reapers can also observe the same
// dead owner, then one can delete the other's new lock. Also cover a failed
// mutator, process death, a busy wait that stalls the event loop, a broken
// mutex file, sequential writes across files, and ordinary concurrent writers
// so recovery cannot weaken serialization.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { fork } = require('node:child_process');
const assert = require('node:assert/strict');
const store = require('../lib/json-store');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function worker() {
  const [file, key, slowOwner, delayStaleUnlink, holdMutator, responsive] = process.argv.slice(3);
  if (responsive === 'yes') setTimeout(() => process.send({ type: 'responsive' }), 100);
  if (slowOwner === 'yes') {
    const open = fs.open.bind(fs);
    let intercepted = false;
    fs.open = async (target, ...args) => {
      const handle = await open(target, ...args);
      if (!intercepted && String(target).startsWith(`${file}.lock`) && args[0] === 'wx') {
        intercepted = true;
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async (...writeArgs) => {
          process.send({ type: 'owner-pending' });
          await new Promise(resolve => process.once('message', resolve));
          return write(...writeArgs);
        };
      }
      return handle;
    };
  }
  if (delayStaleUnlink === 'yes') {
    const unlink = fs.unlink.bind(fs);
    let intercepted = false;
    fs.unlink = async target => {
      if (!intercepted && target === `${file}.lock`) {
        intercepted = true;
        process.send({ type: 'stale-unlink-pending' });
        await new Promise(resolve => process.once('message', resolve));
      }
      return unlink(target);
    };
  }
  await store.update(file, async data => {
    process.send({ type: 'entered', key, observed: Object.keys(data) });
    if (holdMutator === 'yes') await new Promise(resolve => process.once('message', resolve));
    if (key === 'second') await sleep(300);
    data[key] = true;
  });
  process.send({ type: 'done', key });
  process.disconnect();
}

function start(file, key, { slowOwner = false, delayStaleUnlink = false, holdMutator = false, responsive = false } = {}) {
  const child = fork(__filename, ['--worker', file, key, slowOwner ? 'yes' : 'no',
    delayStaleUnlink ? 'yes' : 'no', holdMutator ? 'yes' : 'no', responsive ? 'yes' : 'no'], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  const events = [], waiters = [];
  let output = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => { output += bytes; });
  child.on('message', event => {
    events.push(event);
    for (const waiter of [...waiters]) if (event.type === waiter.type) waiter.resolve(event);
  });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Worker failed (${code}): ${output}`)));
  });
  done.catch(() => {});
  return { child, events, done, event(type) {
    const seen = events.find(event => event.type === type);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Worker did not report ${type}: ${output}`)), 5000);
      const entry = { type, resolve(event) { clearTimeout(timer); waiters.splice(waiters.indexOf(entry), 1); resolve(event); } };
      waiters.push(entry);
      done.catch(reject);
    });
  } };
}

async function main() {
  const output = path.resolve(__dirname, '../output/deep-reliability/storage');
  await fs.mkdir(output, { recursive: true });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-storage-concurrency-'));
  const children = [], results = [];
  try {
    const file = path.join(dir, 'overlap.json');
    await fs.writeFile(file, '{}');
    const first = start(file, 'first', { slowOwner: true }); children.push(first);
    await first.event('owner-pending');
    const second = start(file, 'second'); children.push(second);
    const secondEnteredBeforePublication = await Promise.race([
      second.event('entered').then(() => true), sleep(300).then(() => false)
    ]);
    first.child.send({ type: 'release-owner' });
    await Promise.all([first.done, second.done]);
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    results.push({ name: 'A slow lock owner cannot lose another process update',
      passed: !secondEnteredBeforePublication && data.first === true && data.second === true,
      evidence: { secondEnteredBeforePublication, data, first: first.events, second: second.events } });

    const recovery = path.join(dir, 'recovery.json');
    await fs.writeFile(`${recovery}.lock`, '2147483647');
    const recovered = start(recovery, 'recovered'); children.push(recovered);
    await recovered.event('done'); await recovered.done;
    results.push({ name: 'Dead process locks still recover', passed: (await store.load(recovery)).recovered === true });

    const doubleReap = path.join(dir, 'double-reap.json');
    await fs.writeFile(doubleReap, '{}');
    await fs.writeFile(`${doubleReap}.lock`, '2147483647');
    const delayedReaper = start(doubleReap, 'delayed-reaper', { delayStaleUnlink: true });
    children.push(delayedReaper);
    await delayedReaper.event('stale-unlink-pending');
    const firstReaper = start(doubleReap, 'first-reaper', { holdMutator: true });
    children.push(firstReaper);
    const firstEnteredBeforeRelease = await Promise.race([
      firstReaper.event('entered').then(() => true), sleep(300).then(() => false)
    ]);
    delayedReaper.child.send({ type: 'release-stale-unlink' });
    let overlapping = false;
    if (firstEnteredBeforeRelease) {
      overlapping = await Promise.race([delayedReaper.event('entered').then(() => true), sleep(500).then(() => false)]);
      firstReaper.child.send({ type: 'release-mutator' });
    } else {
      await delayedReaper.done;
      await firstReaper.event('entered');
      firstReaper.child.send({ type: 'release-mutator' });
    }
    await Promise.all([firstReaper.done, delayedReaper.done]);
    const afterDoubleReap = JSON.parse(await fs.readFile(doubleReap, 'utf8'));
    results.push({ name: 'Two stale-lock reapers cannot overlap after one claims the lock',
      passed: !overlapping && afterDoubleReap['first-reaper'] === true && afterDoubleReap['delayed-reaper'] === true,
      evidence: { overlapping, data: afterDoubleReap, first: firstReaper.events, delayed: delayedReaper.events } });

    let rejected = false;
    try { await store.update(recovery, () => { throw new Error('injected mutator failure'); }); }
    catch (error) { rejected = /injected mutator/.test(error.message); }
    await store.update(recovery, data => { data.afterFailure = true; });
    results.push({ name: 'Failed writes release their lock', passed: rejected && (await store.load(recovery)).afterFailure === true });

    const crash = path.join(dir, 'crash.json');
    const doomed = start(crash, 'doomed', { holdMutator: true }); children.push(doomed);
    await doomed.event('entered');
    doomed.child.kill('SIGKILL');
    await doomed.done.catch(() => {});
    const afterCrash = start(crash, 'after-crash'); children.push(afterCrash);
    await afterCrash.done;
    results.push({ name: 'A killed owner releases the OS mutex and stale PID lock',
      passed: (await store.load(crash))['after-crash'] === true });

    const busy = path.join(dir, 'busy.json');
    const holder = start(busy, 'holder', { holdMutator: true }); children.push(holder);
    await holder.event('entered');
    const waiting = start(busy, 'waiting', { responsive: true }); children.push(waiting);
    const keptEventLoopResponsive = await Promise.race([waiting.event('responsive').then(() => true), sleep(1000).then(() => false)]);
    const independent = path.join(dir, 'independent.json');
    await store.update(independent, data => { data.independent = true; });
    holder.child.send({ type: 'release-mutator' });
    await Promise.all([holder.done, waiting.done]);
    results.push({ name: 'A contended store leaves the event loop and other files available',
      passed: keptEventLoopResponsive && (await store.load(independent)).independent === true &&
        Object.keys(await store.load(busy)).length === 2 });

    const sequenceA = path.join(dir, 'sequence-a.json');
    const sequenceB = path.join(dir, 'sequence-b.json');
    await store.withLock(sequenceA, async () => {
      await store.update(sequenceB, data => { data.second = true; });
    });
    await store.update(sequenceA, data => { data.first = true; });
    results.push({ name: 'Sequential writes across distinct files complete',
      passed: (await store.load(sequenceA)).first === true && (await store.load(sequenceB)).second === true });

    const unavailable = path.join(dir, 'unavailable.json');
    await fs.writeFile(`${unavailable}.lock.sqlite`, 'not a database');
    let failedClosed = false;
    try { await store.update(unavailable, data => { data.unsafe = true; }); }
    catch (error) { failedClosed = /database|SQLite|SQLITE/i.test(error.message); }
    results.push({ name: 'An unusable OS mutex fails closed before mutating JSON',
      passed: failedClosed && (await store.load(unavailable)).unsafe !== true });

    const batch = path.join(dir, 'batch.json');
    const writers = Array.from({ length: 8 }, (_, index) => start(batch, `writer-${index}`)); children.push(...writers);
    await Promise.all(writers.map(writer => writer.done));
    const batchData = await store.load(batch);
    const lockFiles = (await fs.readdir(dir)).filter(name => name.endsWith('.lock') || /\.lock\..+\.tmp$/.test(name));
    const mutexMode = (await fs.stat(`${busy}.lock.sqlite`)).mode & 0o777;
    results.push({ name: 'Concurrent processes preserve every update and clean their lock files',
      passed: Object.keys(batchData).length === 8 && lockFiles.length === 0 && mutexMode === 0o600,
      evidence: { keys: Object.keys(batchData), lockFiles, mutexMode } });
    await fs.writeFile(path.join(output, `${process.env.STORAGE_AUDIT_PHASE || 'verification'}.json`), JSON.stringify(results, null, 2) + '\n');
    console.log(JSON.stringify(results, null, 2));
    assert(results.every(result => result.passed), 'Storage concurrency verification failed');
  } finally {
    for (const { child } of children) if (child.exitCode === null) child.kill();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

(process.argv[2] === '--worker' ? worker() : main()).catch(error => { console.error(error); process.exitCode = 1; });
