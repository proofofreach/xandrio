// Small lifecycle primitives for browser modules that can be re-initialised.
// A scope owns listeners and timers, and can be closed repeatedly without
// leaving an old view or media operation alive.
(function exposeLifecycle(global) {
  class LifecycleCancelledError extends Error {
    constructor(message = 'Operation cancelled') {
      super(message);
      this.name = 'LifecycleCancelledError';
      this.cancelled = true;
    }
  }

  class DisposableScope {
    constructor() {
      this.closed = false;
      this._cleanups = [];
    }

    add(cleanup) {
      if (typeof cleanup !== 'function') throw new TypeError('DisposableScope cleanup must be a function');
      let called = false;
      const dispose = () => {
        if (called) return;
        called = true;
        const index = this._cleanups.indexOf(dispose);
        if (index !== -1) this._cleanups.splice(index, 1);
        cleanup();
      };
      if (this.closed) dispose();
      else this._cleanups.push(dispose);
      return dispose;
    }

    listen(target, type, listener, options) {
      target?.addEventListener?.(type, listener, options);
      return this.add(() => target?.removeEventListener?.(type, listener, options));
    }

    timeout(callback, delay, clock = global) {
      let dispose = null;
      const id = clock.setTimeout(() => {
        dispose?.();
        callback();
      }, delay);
      dispose = this.add(() => clock.clearTimeout(id));
      return dispose;
    }

    interval(callback, delay, clock = global) {
      const id = clock.setInterval(callback, delay);
      return this.add(() => clock.clearInterval(id));
    }

    dispose() {
      if (this.closed) return;
      this.closed = true;
      const cleanups = this._cleanups.splice(0).reverse();
      for (const cleanup of cleanups) {
        try { cleanup(); } catch (error) { console.error('Lifecycle cleanup failed:', error); }
      }
    }
  }

  function waitForMediaEvents(target, options = {}) {
    const scope = new DisposableScope();
    const resolveEvents = options.resolveEvents || [];
    const rejectEvents = options.rejectEvents || [];
    const eventError = options.eventError || (() => new Error('Media operation failed'));
    const cancelledError = options.cancelledError || (() => new LifecycleCancelledError());
    let settled = false;
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      scope.dispose();
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };

    for (const eventName of resolveEvents) scope.listen(target, eventName, event => finish(null, event));
    for (const eventName of rejectEvents) scope.listen(target, eventName, event => finish(eventError(event), event));
    if (Number(options.timeoutMs) > 0) {
      scope.timeout(() => {
        if (options.resolveOnTimeout) finish(null);
        else finish(options.timeoutError?.() || new Error('Media operation timed out'));
      }, Number(options.timeoutMs), options.clock || global);
    }

    return {
      promise,
      cancel(reason) { finish(reason || cancelledError()); },
      dispose(reason) { finish(reason || cancelledError()); }
    };
  }

  global.XandrioLifecycle = { DisposableScope, LifecycleCancelledError, waitForMediaEvents };
})(globalThis);
