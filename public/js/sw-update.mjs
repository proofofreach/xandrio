// One-tap application update.
//
// A plain reload never hands control to a waiting service worker: the page
// comes back under the old worker and its old shell, so an installed iPhone
// app needed several launches to update. The update button runs the whole
// handoff instead: fetch the new worker, wait for it to install, ask it to
// activate over the worker's existing XANDRIO_ACTIVATE_WAITING channel, wait
// for this page to change controller, then reload exactly once.
//
// The tap is the user's consent, so this runs even while audio is playing.
// Nothing here activates a worker without that tap. Pure enough to test with
// fake workers: every browser object is passed in.

const INSTALL_TIMEOUT_MS = 30000;
const ACTIVATION_REPLY_TIMEOUT_MS = 3000;
const CONTROLLER_TIMEOUT_MS = 10000;

export const UPDATE_MESSAGES = {
  checking: 'Downloading the update…',
  installing: 'Installing the update…',
  activating: 'Restarting Xandrio…',
  reloading: 'Reloading…',
  unsupported: 'This browser cannot update in place. Close and reopen Xandrio.',
  offline: 'Could not download the update. Check your connection and try again.',
  failed: 'The update did not install. Try again.',
  otherWindows: 'Close other Xandrio windows or tabs, then try again.',
  timeout: 'The update is taking too long. Close and reopen Xandrio.'
};

function waitFor(subscribe, timeoutMs, setTimer, clearTimer) {
  return new Promise(resolve => {
    let unsubscribe = () => {};
    const timer = setTimer(() => {
      unsubscribe();
      resolve(false);
    }, timeoutMs);
    unsubscribe = subscribe(() => {
      clearTimer(timer);
      unsubscribe();
      resolve(true);
    }) || (() => {});
  });
}

function workerReaches(worker, states, timeoutMs, timers) {
  if (!worker) return Promise.resolve('');
  if (states.includes(worker.state)) return Promise.resolve(worker.state);
  return waitFor(done => {
    const onChange = () => {
      if (states.includes(worker.state)) done();
    };
    worker.addEventListener?.('statechange', onChange);
    return () => worker.removeEventListener?.('statechange', onChange);
  }, timeoutMs, timers.setTimeout, timers.clearTimeout).then(() => worker.state);
}

function requestActivation(worker, timers, MessageChannelImpl) {
  if (!worker?.postMessage || typeof MessageChannelImpl !== 'function') {
    return Promise.resolve({ activationRequested: false, reason: 'unsupported' });
  }
  return new Promise(resolve => {
    const channel = new MessageChannelImpl();
    const timer = timers.setTimeout(
      () => resolve({ activationRequested: false, reason: 'no-reply' }),
      ACTIVATION_REPLY_TIMEOUT_MS
    );
    channel.port1.onmessage = event => {
      timers.clearTimeout(timer);
      resolve({
        activationRequested: event?.data?.activationRequested === true,
        reason: String(event?.data?.reason || '')
      });
    };
    try {
      worker.postMessage({ type: 'XANDRIO_ACTIVATE_WAITING' }, [channel.port2]);
    } catch {
      timers.clearTimeout(timer);
      resolve({ activationRequested: false, reason: 'unsupported' });
    }
  });
}

/**
 * Run the update handoff. Resolves to { ok, reason }; `ok` means a reload
 * was started. `onStatus(text)` receives each plain-language step.
 */
export async function applyAppUpdate({
  serviceWorker = globalThis.navigator?.serviceWorker,
  reload = () => globalThis.location?.reload(),
  onStatus = () => {},
  timers = { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) },
  MessageChannelImpl = globalThis.MessageChannel,
  installTimeoutMs = INSTALL_TIMEOUT_MS,
  controllerTimeoutMs = CONTROLLER_TIMEOUT_MS
} = {}) {
  const fail = reason => {
    onStatus(UPDATE_MESSAGES[reason] || UPDATE_MESSAGES.failed);
    return { ok: false, reason };
  };
  if (!serviceWorker?.getRegistration) return fail('unsupported');
  onStatus(UPDATE_MESSAGES.checking);
  let registration;
  try {
    registration = await serviceWorker.getRegistration();
  } catch {
    registration = null;
  }
  if (!registration) return fail('unsupported');
  if (!registration.waiting) {
    try {
      await registration.update();
    } catch {
      return fail('offline');
    }
  }
  let candidate = registration.waiting || registration.installing;
  if (!candidate) {
    // The server build changed but the worker script did not. A reload
    // under the current worker is all the update needs.
    onStatus(UPDATE_MESSAGES.reloading);
    reload();
    return { ok: true, reason: 'no-worker-change' };
  }
  if (candidate.state !== 'installed') {
    onStatus(UPDATE_MESSAGES.installing);
    const state = await workerReaches(candidate, ['installed', 'activated', 'redundant'], installTimeoutMs, timers);
    if (state === 'redundant') return fail('failed');
    if (!['installed', 'activated'].includes(state)) return fail('timeout');
    candidate = registration.waiting || candidate;
  }
  onStatus(UPDATE_MESSAGES.activating);
  const previousController = serviceWorker.controller || null;
  const controllerChanged = previousController
    ? waitFor(done => {
        serviceWorker.addEventListener?.('controllerchange', done);
        return () => serviceWorker.removeEventListener?.('controllerchange', done);
      }, controllerTimeoutMs, timers.setTimeout, timers.clearTimeout)
    : null;
  if (candidate.state !== 'activated') {
    const reply = await requestActivation(candidate, timers, MessageChannelImpl);
    if (!reply.activationRequested) {
      return fail(reply.reason === 'other-clients' ? 'otherWindows' : 'failed');
    }
  }
  // A controlled page switches controller when the new worker activates. An
  // uncontrolled page (first install) never does, so its proof is the worker
  // reaching `activated`.
  const switched = controllerChanged
    ? await controllerChanged
    : (await workerReaches(candidate, ['activated', 'redundant'], controllerTimeoutMs, timers)) === 'activated';
  if (!switched && candidate.state !== 'activated') return fail('timeout');
  onStatus(UPDATE_MESSAGES.reloading);
  reload();
  return { ok: true, reason: '' };
}
