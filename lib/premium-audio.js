/**
 * Progressive premium audio — book-level background upgrade scheduler.
 *
 * When a premium (Chatterbox) voice is active, playback starts instantly on
 * the paired instant voice while this scheduler renders the book's chapters
 * with the premium engine in the background. Order: current chapter, then
 * forward from the listening position, then the remaining earlier chapters.
 * Generation yields whenever live-playback TTS work is in the queue (both
 * engines share the GPU) and stops if the voice changes or prep is disabled.
 */

const { EventEmitter } = require('events');

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
  }

  /**
   * Start (or reposition) background premium prep for a book.
   * Safe to call on every chapter open; a running job just reorders.
   */
  ensureBookPrep(bookId, fromChapter = 0) {
    if (!this.deps.isEnabled() || !this.deps.isPremiumActive()) return null;

    const existing = this.books.get(bookId);
    if (existing && existing.running && existing.variantKey === this.deps.variantKey()) {
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
    this._persist(state);
    this._run(state).catch(err => {
      state.status = 'error';
      state.error = err.message;
      state.running = false;
      this._persist(state);
      this.emit('error', { bookId, error: err.message });
    });
    return state;
  }

  stopBook(bookId) {
    const state = this.books.get(bookId);
    if (state) {
      state.cancelled = true;
      this._removePersisted(state);
    }
  }

  retry(bookId, fromChapter = 0) {
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
    const records = await this.deps.stateStore.list();
    const restored = [];
    for (const record of records) {
      try {
        if (!this.deps.isEnabled()) continue;
        if (this.deps.validateRecoveryRecord) {
          const validation = await this.deps.validateRecoveryRecord(record);
          if (validation === false || validation?.compatible === false) {
            throw new Error(validation?.error || 'Premium recovery variant is incompatible with the current provider');
          }
        }
        const worker = record.variantKey === this.deps.variantKey() && this.deps.isPremiumActive()
          ? this
          : this._variantWorker(record.variantKey);
        if (!worker) throw new Error('No fixed-variant recovery worker is configured');
        const state = worker.ensureBookPrep(record.bookId, record.fromChapter);
        if (state) restored.push(state);
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
    return state.cancelled ||
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
        state.status = 'idle';
        state.running = false;
        await this._removePersisted(state);
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
        if (!(await this.deps.chapterReady(state.bookId, chapterIndex))) {
          await this.deps.prepareChapter(state.bookId, chapterIndex);
        }
        consecutiveFailures = 0;
        state.readyChapters += 1;
        await this._persist(state);
        this.emit('progress', this._snapshot(state));
        this.emit('chapter:premium-ready', { bookId: state.bookId, chapterIndex });
      } catch (err) {
        consecutiveFailures += 1;
        state.error = err.message;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          state.status = 'error';
          state.running = false;
          await this._persist(state);
          this.emit('error', { bookId: state.bookId, error: err.message });
          return;
        }
        // Put the chapter back at the end so one bad chapter can't stall the book.
        done.delete(chapterIndex);
        order.push(chapterIndex);
        await sleep(CONTENTION_POLL_MS);
      }
    }

    state.currentChapter = null;
    state.status = 'ready';
    state.running = false;
    await this._removePersisted(state);
    this.emit('book:premium-ready', { bookId: state.bookId });
  }

  _persist(state) {
    if (!this.deps.stateStore) return Promise.resolve();
    return this.deps.stateStore.put({
      bookId: state.bookId,
      variantKey: state.variantKey,
      fromChapter: state.fromChapter,
      status: state.status
    }).catch(err => this.emit('persistence:error', { bookId: state.bookId, error: err.message }));
  }

  _removePersisted(state) {
    if (!this.deps.stateStore) return Promise.resolve();
    return this.deps.stateStore.remove(state.bookId, state.variantKey)
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
