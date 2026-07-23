/**
 * Priority admission control for scarce generation resources.
 *
 * Callers name a resource (for example `gpu`) and submit work. The scheduler
 * owns capacity and priority ordering; engine and book workflows do not need
 * to know which other producer currently contends for that resource.
 */
class GenerationScheduler {
  constructor({ capacities = { gpu: 1 }, backgroundAgingMs = 30000 } = {}) {
    this.capacities = new Map(Object.entries(capacities));
    this.resources = new Map();
    this.sequence = 0;
    this.backgroundAgingMs = Math.max(1, Number(backgroundAgingMs) || 30000);
  }

  run({ resource = 'gpu', priority = 'background' } = {}, work) {
    if (typeof work !== 'function') return Promise.reject(new TypeError('work must be a function'));
    let item;
    const promise = new Promise((resolve, reject) => {
      const state = this._state(resource);
      item = {
        resource,
        priority,
        sequence: this.sequence++,
        enqueuedAt: Date.now(),
        work,
        resolve,
        reject,
        started: false,
        settled: false,
        controller: new AbortController()
      };
      state.pending.push(item);
      this._drain(resource, state);
    });
    promise.cancel = () => this._cancel(item);
    return promise;
  }

  hasForegroundWork(resource = 'gpu') {
    const state = this.resources.get(resource);
    if (!state) return false;
    return state.active.some(item => this._isForeground(item.priority)) ||
      state.pending.some(item => this._isForeground(item.priority));
  }

  /**
   * Producer-side yield point. This does not reserve capacity: the actual
   * generation job must still enter through run().
   */
  async waitForBackgroundTurn(resource = 'gpu') {
    while (this.hasForegroundWork(resource)) {
      await new Promise(resolve => this._state(resource).waiters.push(resolve));
    }
  }

  getStatus(resource = 'gpu') {
    const state = this._state(resource);
    return { active: state.active.length, queued: state.pending.length };
  }

  _state(resource) {
    if (!this.resources.has(resource)) this.resources.set(resource, { active: [], pending: [], waiters: [] });
    return this.resources.get(resource);
  }

  _capacity(resource) {
    const value = Number(this.capacities.get(resource));
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
  }

  _weight(priority) {
    return priority === 'immediate' ? 0 : priority === 'next' ? 1 : 2;
  }

  _effectiveWeight(item) {
    const agePromotions = Math.floor((Date.now() - item.enqueuedAt) / this.backgroundAgingMs);
    return Math.max(0, this._weight(item.priority) - agePromotions);
  }

  _cancel(item) {
    if (!item || item.settled || item.controller.signal.aborted) return false;
    const state = this.resources.get(item.resource);
    if (item.started) {
      // Admitted work retains its capacity slot until it cooperatively settles;
      // releasing early would exceed the resource capacity while it still runs.
      item.controller.abort();
      return true;
    }
    const index = state?.pending.indexOf(item) ?? -1;
    if (index < 0) return false;
    state.pending.splice(index, 1);
    item.controller.abort();
    item.settled = true;
    const error = new Error('Generation admission cancelled');
    error.name = 'AbortError';
    item.reject(error);
    this._notify(state);
    return true;
  }

  _isForeground(priority) {
    return priority === 'immediate' || priority === 'next';
  }

  _notify(state) {
    const waiters = state.waiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  _drain(resource, state) {
    state.pending.sort((a, b) => this._effectiveWeight(a) - this._effectiveWeight(b) || a.sequence - b.sequence);
    while (state.active.length < this._capacity(resource) && state.pending.length) {
      const item = state.pending.shift();
      item.started = true;
      state.active.push(item);
      Promise.resolve()
        .then(() => item.work({
          signal: item.controller.signal,
          resource: item.resource,
          priority: item.priority
        }))
        .then(value => {
          item.settled = true;
          state.active.splice(state.active.indexOf(item), 1);
          this._notify(state);
          this._drain(resource, state);
          item.resolve(value);
        }, error => {
          item.settled = true;
          state.active.splice(state.active.indexOf(item), 1);
          this._notify(state);
          this._drain(resource, state);
          item.reject(error);
        });
    }
    this._notify(state);
  }
}

module.exports = GenerationScheduler;
