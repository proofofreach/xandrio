const assert = require('assert');
const GenerationScheduler = require('../lib/generation-scheduler');
const TTSQueue = require('../lib/tts-queue');

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

async function run() {
  let passed = 0;
  let failed = 0;
  const test = async (name, fn) => {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${name}: ${err.stack || err.message}`);
    }
  };

  console.log('\nGeneration Scheduler Tests\n');

  await test('foreground GPU work runs before queued background work', async () => {
    const scheduler = new GenerationScheduler({ capacities: { gpu: 1 } });
    const blocker = deferred();
    const order = [];

    const active = scheduler.run({ resource: 'gpu', priority: 'background' }, async () => {
      order.push('active-background');
      await blocker.promise;
    });
    await new Promise(resolve => setImmediate(resolve));

    const background = scheduler.run({ resource: 'gpu', priority: 'background' }, async () => {
      order.push('queued-background');
    });
    const foreground = scheduler.run({ resource: 'gpu', priority: 'immediate' }, async () => {
      order.push('foreground');
    });

    blocker.resolve();
    await Promise.all([active, background, foreground]);
    assert.deepStrictEqual(order, ['active-background', 'foreground', 'queued-background']);
  });

  await test('separate TTS queues share one GPU capacity', async () => {
    let active = 0;
    let maximum = 0;
    class SharedQueue extends TTSQueue {
      async _generateTTS() {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise(resolve => setTimeout(resolve, 20));
        active--;
      }
    }
    const scheduler = new GenerationScheduler({ capacities: { gpu: 1 } });
    const first = new SharedQueue({ generationScheduler: scheduler });
    const second = new SharedQueue({ generationScheduler: scheduler });
    const firstId = await first.enqueue({ text: 'one', outputPath: '/tmp/scheduler-one.mp3', voice: 'kokoro:af_heart' });
    const secondId = await second.enqueue({ text: 'two', outputPath: '/tmp/scheduler-two.mp3', voice: 'chatterbox:default' });
    await Promise.all([first.waitFor(firstId), second.waitFor(secondId)]);
    assert.strictEqual(maximum, 1);
  });

  await test('queued work can be cancelled before scarce-resource admission', async () => {
    const scheduler = new GenerationScheduler({ capacities: { gpu: 1 } });
    const blocker = deferred();
    const active = scheduler.run({}, () => blocker.promise);
    const pending = scheduler.run({}, async () => { throw new Error('cancelled work ran'); });
    assert.strictEqual(pending.cancel(), true);
    await assert.rejects(pending, err => err.name === 'AbortError');
    blocker.resolve();
    await active;
  });

  await test('already-admitted work receives cancellation signal and releases capacity after settling', async () => {
    const scheduler = new GenerationScheduler({ capacities: { gpu: 1 } });
    let observedContext = null;
    let secondStarted = false;
    const admitted = scheduler.run({ resource: 'gpu', priority: 'background' }, context => {
      observedContext = context;
      return new Promise((resolve, reject) => {
        context.signal.addEventListener('abort', () => {
          const error = new Error('cooperative stop');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    });
    await new Promise(resolve => setImmediate(resolve));
    const second = scheduler.run({ resource: 'gpu' }, async () => { secondStarted = true; });
    assert.strictEqual(scheduler.getStatus().active, 1);
    assert.strictEqual(scheduler.getStatus().queued, 1);
    assert.strictEqual(admitted.cancel(), true);
    assert.strictEqual(observedContext.resource, 'gpu');
    assert.strictEqual(observedContext.priority, 'background');
    assert.strictEqual(observedContext.signal.aborted, true);
    assert.strictEqual(secondStarted, false, 'capacity remains held until admitted work settles');
    await assert.rejects(admitted, error => error.name === 'AbortError');
    await second;
    assert.strictEqual(secondStarted, true);
    assert.deepStrictEqual(scheduler.getStatus(), { active: 0, queued: 0 });
    assert.strictEqual(admitted.cancel(), false, 'settled admission cannot be cancelled twice');
  });

  await test('queue cancellation before GPU admission never starts engine work', async () => {
    const scheduler = new GenerationScheduler({ capacities: { gpu: 1 } });
    const blocker = deferred();
    const active = scheduler.run({ resource: 'gpu' }, () => blocker.promise);
    let starts = 0;
    class PendingQueue extends TTSQueue {
      async _generateTTS() { starts++; }
    }
    const queue = new PendingQueue({ generationScheduler: scheduler });
    const id = await queue.enqueue({
      text: 'never starts', outputPath: '/tmp/cancel-before-admission.mp3', voice: 'kokoro:af_heart'
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(queue.cancel(id), true);
    await assert.rejects(queue.waitFor(id), /cancelled|Unknown/);
    assert.strictEqual(starts, 0);
    blocker.resolve();
    await active;
  });

  await test('aging prevents background starvation', async () => {
    const scheduler = new GenerationScheduler({ capacities: { gpu: 1 }, backgroundAgingMs: 5 });
    const blocker = deferred();
    const order = [];
    const active = scheduler.run({}, () => blocker.promise);
    const oldBackground = scheduler.run({ priority: 'background' }, async () => order.push('background'));
    await new Promise(resolve => setTimeout(resolve, 12));
    const immediate = scheduler.run({ priority: 'immediate' }, async () => order.push('immediate'));
    blocker.resolve();
    await Promise.all([active, oldBackground, immediate]);
    assert.deepStrictEqual(order, ['background', 'immediate']);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

run();
