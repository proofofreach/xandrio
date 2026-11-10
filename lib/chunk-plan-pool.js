'use strict';

/**
 * Chunk-plan worker pool.
 *
 * Planning a long chapter is 150-300 ms of synchronous CPU on the production
 * VPS, and every plan on the main thread stalls HLS segments and status polls
 * for every listener. This pool runs lib/chunk-planner.js on one or two
 * worker threads so no caller can block the event loop with planning.
 *
 * Workers spawn lazily on the first plan and are unref'd while idle, so the
 * pool never keeps the process alive. If a worker cannot be created, or a
 * worker dies mid-plan, the affected plan runs in-process instead (yielding
 * to the event loop first), so results are identical either way. Repeated
 * worker failures disable workers for the rest of the process and log once.
 */

const os = require('os');
const path = require('path');
const workerThreads = require('worker_threads');
const { planSplitChunks } = require('./chunk-planner');

const WORKER_SCRIPT = path.join(__dirname, 'chunk-plan-worker.js');
// A small VPS also runs ffmpeg and the TTS engines; leave CPUs for them.
const MAX_DEFAULT_WORKERS = 2;
// Consecutive worker failures before the pool stops trying workers.
const WORKER_FAILURE_LIMIT = 3;
// A plan is milliseconds of CPU; a worker silent this long is stuck.
const DEFAULT_JOB_TIMEOUT_MS = 30 * 1000;

function defaultPoolSize(env = process.env) {
  const configured = Number.parseInt(env.XANDRIO_CHUNK_PLAN_WORKERS, 10);
  if (Number.isInteger(configured) && configured >= 0) return configured;
  const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(MAX_DEFAULT_WORKERS, cpus - 1));
}

function createChunkPlanPool({
  size = defaultPoolSize(),
  workerScript = WORKER_SCRIPT,
  Worker = workerThreads.Worker,
  planInProcess = planSplitChunks,
  jobTimeoutMs = DEFAULT_JOB_TIMEOUT_MS,
  yieldFn = () => new Promise(resolve => setImmediate(resolve)),
  log = message => console.warn(message)
} = {}) {
  const workers = [];
  const queue = [];
  let nextJobId = 1;
  let workersDisabled = size <= 0;
  let consecutiveFailures = 0;
  let closed = false;
  let fallbackChain = Promise.resolve();
  const stats = { workerPlans: 0, inProcessPlans: 0, workerFailures: 0 };

  function disableWorkers(reason) {
    if (workersDisabled) return;
    workersDisabled = true;
    log(`[chunk-plan] worker threads unavailable (${reason}); planning in-process`);
  }

  // Serialize in-process plans and yield before each so queued I/O runs
  // between them. This is the pre-pool behavior, kept only as a fallback.
  function runInProcess(job) {
    fallbackChain = fallbackChain
      .then(yieldFn)
      .then(() => {
        stats.inProcessPlans++;
        job.resolve(planInProcess(job.text, job.maxChars, job.splitPolicy, job.engineLimits));
      })
      .catch(job.reject);
  }

  function spawnWorker() {
    let worker;
    try {
      worker = new Worker(workerScript);
    } catch (error) {
      disableWorkers(error?.message || String(error));
      return null;
    }
    const slot = { worker, job: null, timer: null };
    const clearJob = () => {
      clearTimeout(slot.timer);
      slot.timer = null;
      const job = slot.job;
      slot.job = null;
      return job;
    };
    // Any worker failure (crash, exit, undecodable message, timeout) retires
    // the worker and finishes its plan in-process, so no job stays unsettled.
    const fail = reason => {
      const index = workers.indexOf(slot);
      if (index !== -1) workers.splice(index, 1);
      worker.terminate().catch(() => {});
      stats.workerFailures++;
      const job = clearJob();
      // The plan is pure, so finish it in-process instead of failing the caller.
      if (job) runInProcess(job);
      if (++consecutiveFailures >= WORKER_FAILURE_LIMIT) disableWorkers(reason);
      dispatch();
    };
    slot.fail = fail;
    worker.on('message', message => {
      if (!slot.job || message?.id !== slot.job.id) return;
      const job = clearJob();
      consecutiveFailures = 0;
      if (message.ok) {
        stats.workerPlans++;
        job.resolve(message.chunks);
      } else {
        job.reject(new Error(message.error || 'Chunk plan worker failed'));
      }
      if (!queue.length) worker.unref();
      dispatch();
    });
    worker.on('error', error => fail(error?.message || String(error)));
    worker.on('messageerror', error => fail(`worker reply could not be decoded: ${error?.message || error}`));
    worker.on('exit', code => {
      if (workers.includes(slot)) fail(`worker exited with code ${code}`);
    });
    worker.unref();
    workers.push(slot);
    return slot;
  }

  function dispatch() {
    while (queue.length) {
      if (closed || workersDisabled) {
        runInProcess(queue.shift());
        continue;
      }
      let slot = workers.find(candidate => !candidate.job);
      if (!slot && workers.length < size) slot = spawnWorker();
      if (!slot) {
        if (workersDisabled) continue;
        return; // every worker is busy; the next reply dispatches again
      }
      const job = queue.shift();
      slot.job = job;
      // Hold the process open only while a plan is in flight.
      slot.worker.ref();
      try {
        slot.worker.postMessage({ id: job.id, text: job.text, maxChars: job.maxChars, splitPolicy: job.splitPolicy, engineLimits: job.engineLimits });
      } catch (error) {
        // Unclonable input is the caller's error; the worker stays healthy.
        slot.job = null;
        if (!queue.length) slot.worker.unref();
        job.reject(error);
        continue;
      }
      // The timer stays ref'd: a plan in flight must keep the process alive
      // until it settles, by reply, failure or timeout.
      if (jobTimeoutMs > 0) {
        slot.timer = setTimeout(() => slot.fail(`plan timed out after ${jobTimeoutMs}ms`), jobTimeoutMs);
      }
    }
  }

  function plan(text, maxChars, splitPolicy, engineLimits = null) {
    return new Promise((resolve, reject) => {
      queue.push({ id: nextJobId++, text, maxChars, splitPolicy, engineLimits, resolve, reject });
      dispatch();
    });
  }

  async function close() {
    closed = true;
    const slots = workers.splice(0, workers.length);
    for (const slot of slots) {
      clearTimeout(slot.timer);
      if (slot.job) {
        const job = slot.job;
        slot.job = null;
        runInProcess(job);
      }
    }
    await Promise.all(slots.map(slot => slot.worker.terminate().catch(() => {})));
    dispatch();
  }

  return {
    plan,
    close,
    stats: () => ({
      ...stats,
      workers: workers.length,
      queued: queue.length,
      workersDisabled
    })
  };
}

module.exports = { createChunkPlanPool, defaultPoolSize, WORKER_SCRIPT };
