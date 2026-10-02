/**
 * Progressive premium audio — book-level background upgrade scheduler.
 *
 * Each job captures its book's narrator and renders chapters in the
 * background. Playback fallback is a separate, explicit book preference.
 * Order: current chapter, then
 * forward from the listening position, then the remaining earlier chapters.
 * Generation yields whenever live-playback TTS work is in the queue (both
 * engines share a generation lane) and stops when its intent is retired.
 */

const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');

const CONTENTION_POLL_MS = 2000;
const ENGINE_OFFLINE_POLL_MS = 10000;
const MAX_CONSECUTIVE_FAILURES = 3;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class PremiumAudioPrep extends EventEmitter {
  /**
   * @param {object} deps
   * @param {() => boolean} deps.isEnabled - settings toggle
   * @param {() => boolean} deps.isPremiumActive - active voice is a premium voice
   * @param {() => string} deps.variantKey - premium variant key for the active voice
   * @param {(bookId: string) => Promise<{chapterCount: number}>} deps.getBookInfo
   * @param {(bookId: string, chapterIndex: number) => Promise<string>} deps.prepareChapter
   * @param {(bookId: string, chapterIndex: number) => Promise<boolean>} deps.chapterReady
   * @param {() => boolean} [deps.hasForegroundWork] - legacy contention probe
   * @param {{waitForBackgroundTurn: Function}} [deps.generationScheduler]
   * @param {{list: Function, put: Function, remove: Function}} [deps.stateStore]
   * @param {() => Promise<boolean>} deps.isEngineUp
   * @param {() => void} [deps.startEngine] - request an engine (re)start; must be
   *   idempotent — called on every engine-offline poll until health passes
   * @param {(variantKey: string) => PremiumAudioPrep|object} [deps.createVariantWorker]
   *   builds a fixed-variant worker without changing the active UI voice
   */
  constructor(deps) {
    super();
    this.deps = deps;
    /** @type {Map<string, object>} bookId -> job state */
    this.books = new Map();
    this.variantWorkers = new Map();
    this.runs = new Map();
  }

  /**
   * Start (or reposition) background premium prep for a book.
   * Safe to call on every chapter open; a running job just reorders.
   */
  ensureBookPrep(bookId, fromChapter = 0, options = {}) {
    if (this.deps.resolveBookVariant) {
      const identity = this.deps.resolveBookVariant(bookId);
      if (!identity || (!this.deps.isEnabled() && options.desiredState !== 'paused')) return null;
      const previous = this.books.get(bookId);
      if (previous && previous.variantKey !== identity.variantKey) this._retire(previous);
      const worker = this._variantWorker(identity.variantKey);
      const state = worker.ensureBookPrep(bookId, fromChapter, {
        ...options, ...(!this.deps.isEnabled() ? { restore: true, suspended: true } : {})
      });
      if (state) this.books.set(bookId, state);
      return state;
    }
    if ((!this.deps.isEnabled() && !options.restore) || !this.deps.isPremiumActive()) return null;

    const existing = this.books.get(bookId);
    if (existing?.desiredState === 'paused' && !options.resume) return existing;
    if (existing && !existing.cancelled && existing.running && existing.variantKey === this.deps.variantKey()) {
      if (existing.fromChapter !== fromChapter) {
        existing.fromChapter = fromChapter;
        existing.reorder = true;
        this._persist(existing);
      }
      return existing;
    }
    if (existing && existing.running) {
      // Voice changed under a running job; let it notice and exit, start fresh.
      existing.cancelled = true;
    }

    const state = {
      bookId,
      jobId: options.jobId || randomUUID(),
      voiceId: this.deps.voiceId || null,
      desiredState: options.desiredState || 'running',
      controller: new AbortController(),
      running: true,
      cancelled: false,
      status: 'generating', // generating | paused | engineOffline | ready | error | idle
      error: null,
      fromChapter,
      reorder: false,
      readyChapters: 0,
      totalChapters: 0,
      currentChapter: null,
      variantKey: this.deps.variantKey(),
      startedAt: Date.now()
    };
    this.books.set(bookId, state);
    if (state.desiredState === 'paused') {
      state.status = 'userPaused';
      state.running = false;
    }
    if (options.suspended && state.desiredState !== 'paused') {
      state.status = options.unavailable ? 'engineOffline' : 'disabled';
      state.running = false;
    }
    const selected = this._persist(state, { select: true, required: true });
    state.persisted = selected;
    const run = selected.then(() => state.desiredState === 'paused' || options.suspended ? null : this._run(state)).catch(err => {
      if (state.cancelled || state.desiredState === 'paused' || this.books.get(bookId) !== state) return;
      state.status = 'error';
      state.error = err.message;
      state.running = false;
      this._persist(state);
      this._reportError({ bookId, error: err.message });
    }).finally(() => {
      const runs = this.runs.get(bookId);
      runs?.delete(run);
      if (runs?.size === 0) this.runs.delete(bookId);
    });
    const runs = this.runs.get(bookId) || new Set();
    runs.add(run);
    this.runs.set(bookId, runs);
    return state;
  }

  _reportError(detail) {
    if (this.listenerCount('error')) this.emit('error', detail);
    else this.emit('preparation:error', detail);
  }

  _workerForState(state) {
    return this.deps.resolveBookVariant ? this._variantWorker(state.variantKey) : this;
  }

  _retire(state) {
    state.cancelled = true;
    const worker = this._workerForState(state);
    // Mark the precise claim retired synchronously before any awaited cleanup.
    const release = worker.deps.releaseClaims?.(state);
    state.controller?.abort();
    return Promise.resolve(release).catch(error =>
      this.emit('persistence:error', { bookId: state.bookId, error: error.message }));
  }

  async suspend() {
    for (const state of this.books.values()) {
      if (state.desiredState === 'paused' || state.status === 'ready') continue;
      const worker = this._workerForState(state);
      state.status = 'disabled';
      state.running = false;
      await worker._persist(state, { required: true });
      await worker.deps.releaseClaims?.(state);
      state.controller.abort();
    }
  }

  async pause(bookId) {
    const state = this.getState(bookId);
    if (!state) return null;
    state.desiredState = 'paused';
    state.status = 'userPaused';
    state.running = false;
    const worker = this._workerForState(state);
    await worker._persist(state, { required: true });
    await worker.deps.releaseClaims?.(state);
    state.controller.abort();
    return state;
  }

  async resume(bookId, fromChapter = null) {
    const state = this.getState(bookId);
    if (!this.deps.isEnabled()) return state;
    if (state) {
      await this._retire(state);
      const worker = this._workerForState(state);
      worker.books.delete(bookId);
      this.books.delete(bookId);
    }
    const resumed = this.ensureBookPrep(bookId, fromChapter ?? state?.fromChapter ?? 0, { resume: true });
    await resumed?.persisted;
    return resumed;
  }

  async stopBook(bookId, { preserveJournal = false } = {}) {
    const workers = [this, ...this.variantWorkers.values()];
    const states = [];
    for (const worker of workers) {
      const state = worker.books.get(bookId);
      if (!state) continue;
      await worker._retire(state);
      worker.books.delete(bookId);
      states.push([worker, state]);
    }
    // Narrator changes leave the old record until the replacement is durable.
    // A restart in that gap can then preserve an explicit manual pause.
    if (preserveJournal) return;
    if (typeof this.deps.stateStore?.removePremiumForBook === 'function') {
      await this.deps.stateStore.removePremiumForBook(bookId);
      return;
    }
    await Promise.all(states.map(([worker, state]) => worker._removePersisted(state, { force: true })));
  }

  async waitForIdle(bookId) {
    const workers = [this, ...this.variantWorkers.values()];
    while (true) {
      const runs = workers.flatMap(worker => [...(worker.runs.get(bookId) || [])]);
      if (runs.length === 0) return;
      await Promise.all(runs.map(run => run.catch(() => {})));
    }
  }

  retry(bookId, fromChapter = 0) {
    if (this.deps.resolveBookVariant) return this.resume(bookId, fromChapter);
    const state = this.books.get(bookId);
    if (state && state.running) state.cancelled = true;
    this.books.delete(bookId);
    return this.ensureBookPrep(bookId, fromChapter);
  }

  getState(bookId) {
    return this.books.get(bookId) || null;
  }

  /** Reconstruct unfinished work recorded by an earlier process. */
  async restore() {
    if (!this.deps.stateStore) return [];
    if (this.deps.resolveBookVariant) {
      await this.deps.stateStore.reconcilePremium?.(bookId => this.deps.resolveBookVariant(bookId));
    }
    const records = await this.deps.stateStore.list();
    const restored = [];
    for (const record of records) {
      try {
        if (!this.deps.isEnabled() && !this.deps.resolveBookVariant) continue;
        let unavailable = false;
        if (this.deps.validateRecoveryRecord) {
          const validation = await this.deps.validateRecoveryRecord(record);
          // Disabled providers retain their durable work for a later restart.
          // Unavailability is not evidence of an incompatible model or voice.
          if (validation?.compatible !== false && validation?.paused) {
            if (!this.deps.resolveBookVariant) continue;
            unavailable = true;
          }
          if (validation === false || validation?.compatible === false) {
            throw new Error(validation?.error || 'Premium recovery variant is incompatible with the current provider');
          }
        }
        const worker = !this.deps.resolveBookVariant && record.variantKey === this.deps.variantKey() && this.deps.isPremiumActive()
          ? this
          : this._variantWorker(record.variantKey);
        if (!worker) throw new Error('No fixed-variant recovery worker is configured');
        const retiredInThisProcess = worker.getState(record.bookId)?.controller.signal.aborted;
        const state = worker.ensureBookPrep(record.bookId, record.fromChapter, {
          jobId: retiredInThisProcess ? undefined : record.jobId, desiredState: record.desiredState || 'running',
          restore: true, suspended: unavailable || !this.deps.isEnabled(), unavailable
        });
        if (state) {
          await state.persisted;
          if (this.deps.resolveBookVariant) this.books.set(record.bookId, state);
          restored.push(state);
        }
      } catch (error) {
        await this.deps.stateStore.quarantinePremium?.(record, error);
        this.emit('recovery:error', {
          bookId: record.bookId,
          variantKey: record.variantKey,
          error: error.message
        });
      }
    }
    return restored;
  }

  _variantWorker(variantKey) {
    if (this.variantWorkers.has(variantKey)) return this.variantWorkers.get(variantKey);
    if (typeof this.deps.createVariantWorker !== 'function') return null;
    const created = this.deps.createVariantWorker(variantKey);
    const worker = created instanceof PremiumAudioPrep
      ? created
      : new PremiumAudioPrep({
        ...created,
        generationScheduler: created?.generationScheduler || this.deps.generationScheduler,
        stateStore: created?.stateStore || this.deps.stateStore,
        variantKey: () => variantKey,
        isEnabled: created?.isEnabled || (() => this.deps.isEnabled()),
        isPremiumActive: created?.isPremiumActive || (() => true)
      });
    this.variantWorkers.set(variantKey, worker);
    return worker;
  }

  _chapterOrder(total, from) {
    const start = Math.min(Math.max(0, from), Math.max(0, total - 1));
    const order = [];
    for (let i = start; i < total; i++) order.push(i);
    for (let i = 0; i < start; i++) order.push(i);
    return order;
  }

  _shouldStop(state) {
    return state.cancelled || state.controller.signal.aborted || this.books.get(state.bookId) !== state || state.desiredState === 'paused' ||
      !this.deps.isEnabled() ||
      !this.deps.isPremiumActive() ||
      this.deps.variantKey() !== state.variantKey;
  }

  async _run(state) {
    const { chapterCount } = await this.deps.getBookInfo(state.bookId);
    state.totalChapters = chapterCount;

    const done = new Set();
    let order = this._chapterOrder(chapterCount, state.fromChapter);
    let consecutiveFailures = 0;

    while (order.length) {
      if (this._shouldStop(state)) {
        state.status = state.desiredState === 'paused' ? 'userPaused' : !this.deps.isEnabled() ? 'disabled' : 'idle';
        state.running = false;
        if (!state.cancelled && !this.deps.isEnabled()) await this._persist(state);
        else if (!state.cancelled && !state.controller.signal.aborted && state.desiredState !== 'paused') await this._removePersisted(state);
        return;
      }
      if (state.reorder) {
        state.reorder = false;
        order = this._chapterOrder(chapterCount, state.fromChapter).filter(i => !done.has(i));
        continue;
      }
      // Yield to live playback generation (shared GPU).
      if (this.deps.generationScheduler) {
        if (this.deps.generationScheduler.hasForegroundWork?.('gpu') && state.status !== 'paused') {
          state.status = 'paused';
          await this._persist(state);
          this.emit('progress', this._snapshot(state));
        }
        await this.deps.generationScheduler.waitForBackgroundTurn('gpu');
        if (this._shouldStop(state)) continue;
      } else if (this.deps.hasForegroundWork?.()) {
        if (state.status !== 'paused') {
          state.status = 'paused';
          await this._persist(state);
          this.emit('progress', this._snapshot(state));
        }
        await sleep(CONTENTION_POLL_MS);
        continue;
      }
      // Engine down: request a (re)start and hold until it answers health
      // checks (playback continues on the instant voice meanwhile). Without
      // the start request this would deadlock — the only other spawn point
      // is inside prepareChapter, which this hold gates.
      if (!(await this.deps.isEngineUp())) {
        if (this._shouldStop(state)) continue;
        try {
          this.deps.startEngine?.();
        } catch {}
        if (state.status !== 'engineOffline') {
          state.status = 'engineOffline';
          await this._persist(state);
          this.emit('progress', this._snapshot(state));
        }
        await sleep(ENGINE_OFFLINE_POLL_MS);
        continue;
      }

      state.status = 'generating';
      const chapterIndex = order.shift();
      done.add(chapterIndex);
      state.currentChapter = chapterIndex;

      try {
        const chapterIsReady = await this.deps.chapterReady(state.bookId, chapterIndex);
        if (this._shouldStop(state)) continue;
        if (!chapterIsReady) {
          await this.deps.prepareChapter(state.bookId, chapterIndex, { signal: state.controller.signal, requestId: state.jobId });
        }
        if (this._shouldStop(state)) continue;
        consecutiveFailures = 0;
        state.readyChapters += 1;
        await this._persist(state);
        this.emit('progress', this._snapshot(state));
        this.emit('chapter:premium-ready', { bookId: state.bookId, chapterIndex });
      } catch (err) {
        if (this._shouldStop(state)) continue;
        consecutiveFailures += 1;
        state.error = err.message;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          state.status = 'error';
          state.running = false;
          await this._persist(state);
          this._reportError({ bookId: state.bookId, error: err.message });
          return;
        }
        // Put the chapter back at the end so one bad chapter can't stall the book.
        done.delete(chapterIndex);
        order.push(chapterIndex);
        await sleep(CONTENTION_POLL_MS);
      }
    }

    if (this._shouldStop(state)) { state.running = false; return; }
    state.currentChapter = null;
    state.status = 'ready';
    state.running = false;
    await this._removePersisted(state);
    this.emit('book:premium-ready', { bookId: state.bookId });
  }

  _persist(state, { select = false, required = false } = {}) {
    if (
      !this.deps.stateStore ||
      state.cancelled ||
      this.books.get(state.bookId) !== state
    ) return Promise.resolve();
    const store = this.deps.stateStore;
    const write = select && store.selectPremium ? store.selectPremium.bind(store) : store.put.bind(store);
    return write({
      jobId: state.jobId, voiceId: state.voiceId, desiredState: state.desiredState,
      bookId: state.bookId,
      variantKey: state.variantKey,
      fromChapter: state.fromChapter,
      status: state.status
    }).catch(err => {
      this.emit('persistence:error', { bookId: state.bookId, error: err.message });
      if (required) throw err;
    });
  }

  _removePersisted(state, { force = false } = {}) {
    if (!this.deps.stateStore) return Promise.resolve();
    if (!force && this.books.get(state.bookId) !== state) return Promise.resolve();
    return this.deps.stateStore.remove(state.bookId, state.variantKey, state.jobId)
      .catch(err => this.emit('persistence:error', { bookId: state.bookId, error: err.message }));
  }

  _snapshot(state) {
    return {
      bookId: state.bookId,
      status: state.status,
      readyChapters: state.readyChapters,
      totalChapters: state.totalChapters,
      currentChapter: state.currentChapter,
      error: state.error
    };
  }
}

module.exports = PremiumAudioPrep;
