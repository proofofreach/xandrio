const assert = require('assert');
const http = require('http');

const originalGrace = process.env.IMPORT_JOB_TERMINAL_GRACE_MS;
process.env.IMPORT_JOB_TERMINAL_GRACE_MS = '5';
const { app, __test } = require('../server');
if (originalGrace === undefined) delete process.env.IMPORT_JOB_TERMINAL_GRACE_MS;
else process.env.IMPORT_JOB_TERMINAL_GRACE_MS = originalGrace;

const {
  createImportJob,
  emitImportJob,
  importJobs
} = __test;

let passed = 0;

function check(condition, message) {
  assert(condition, message);
  passed++;
}

function startServer() {
  return new Promise(resolve => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function openEventStream(base, jobId) {
  return new Promise((resolve, reject) => {
    const request = http.get(`${base}/api/download/${jobId}/events`, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      resolve({
        response,
        chunks,
        ended: new Promise(done => response.once('end', done))
      });
    });
    request.once('error', reject);
  });
}

(async () => {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const runningJob = createImportJob();
  const terminalJob = createImportJob();
  let runningSubscriber;
  try {
    runningSubscriber = await openEventStream(base, runningJob.id);
    check(runningJob.subscribers.size === 1,
      'a running import job keeps its SSE subscriber connected');

    const subscribers = [];
    for (let index = 0; index < 10; index++) {
      subscribers.push(await openEventStream(base, terminalJob.id));
    }
    check(terminalJob.subscribers.size === 10,
      'the job tracks active SSE subscribers');

    terminalJob.status = 'complete';
    emitImportJob(terminalJob, 'complete', { result: { success: true } });
    await Promise.all(subscribers.map(subscriber => subscriber.ended));
    check(terminalJob.subscribers.size === 0 && terminalJob.listeners.size === 0,
      'injected terminal grace closes SSE subscribers and removes listeners');
    check(importJobs.get(terminalJob.id) === terminalJob,
      'terminal grace preserves the job for the retention window');

    const replay = await openEventStream(base, terminalJob.id);
    await replay.ended;
    check(replay.chunks.join('').includes('event: complete'),
      'a terminal event remains replayable within the retention window');

    await new Promise(resolve => setTimeout(resolve, 20));
    check(runningJob.subscribers.size === 1 && !runningSubscriber.response.complete,
      'running jobs never close subscribers during terminal grace');

    const closed = new Promise(resolve => runningSubscriber.response.once('close', resolve));
    runningSubscriber.response.destroy();
    await closed;
  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  console.log(`${passed} passed, 0 failed`);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
