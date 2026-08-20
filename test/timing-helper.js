// Timing in tests, without measuring the machine.
//
// A bound like `assert(Date.now() - startedAt < 250)` reads as "this is fast",
// but what it actually measures is how loaded the host is. Every one of those
// bounds in this suite eventually failed on a busy CI runner while the code
// under test was perfectly correct, and a test that fails for reasons unrelated
// to its subject trains everyone to re-run rather than read it.
//
// Two mechanisms replace them.
//
// `settlesBefore` states the real property: this work short-circuited some slow
// path instead of waiting it out. The bound comes from that slow path — the
// configured timeout, the retry backoff, the stalled lookup — so it stays
// meaningful when the constant changes, and leaves a margin of the whole slow
// path rather than a hand-picked number.
//
// `rejectAfter` is a hang guard and nothing more. It never decides whether a
// test passes; it exists so a test that would otherwise wait forever reports
// what it was waiting for. Its bound should be generous.
//
// Neither leaves a timer holding the process open, and neither leaves an
// unhandled rejection behind once the work it guarded has finished.
//
// One kind of wall-clock bound is legitimate and deliberately left alone:
// complexity guards, such as the ones in test-catalog-search, test-epub-zip-limits
// and test-pdf-extraction. Those fail on an algorithm going quadratic, where the
// gap is minutes against milliseconds, so load cannot plausibly cross the line.
// The distinction is the margin: if a plausibly slow machine can fail the
// assertion, the assertion is measuring the machine.

const HANG_GUARD_MS = 10_000;

function rejectAfter(ms, message) {
  let timer;
  const promise = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  // Once cancelled nothing awaits this; keep Node from reporting the rejection.
  promise.catch(() => {});
  return { promise, cancel: () => clearTimeout(timer) };
}

// Resolves with the settled outcome of `work` — `{ status: 'fulfilled', value }`
// or `{ status: 'rejected', reason }` — so the caller still asserts on the error
// it expected. Rejects only when the slow path elapsed first, which is the one
// failure this is here to catch.
function settlesBefore(work, slowPathMs, message) {
  const guard = rejectAfter(slowPathMs, message);
  const reflected = Promise.resolve(work).then(
    value => ({ status: 'fulfilled', value }),
    reason => ({ status: 'rejected', reason })
  );
  return Promise.race([reflected, guard.promise]).finally(guard.cancel);
}

module.exports = { HANG_GUARD_MS, rejectAfter, settlesBefore };
