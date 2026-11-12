# State machines

This file lists the app's explicit and implicit state machines. For each one it gives the states, the transitions, and the invariants the code relies on. It also keeps the ledger of invalid states and transitions that the code could reach, with their fix status.

- **Explicit** machines have a `status`, `state` or `phase` field.
- **Implicit** machines are built from flag combinations, in-flight maps, tokens, locks, timers, child processes, or files that act as state (temp, partial and final files, journals).

References use function names, plus `file:line` where the line is stable. Line numbers drift; search for the function.

**Keep this file current.** When you add or change a transition, update its table. When you fix a reachable invalid state, move it to the ledger with its issue and commit.

Audit date: 2026-11-07, at base commit `0a9b632`. Issues use the `state-machine-audit` label in `proofofreach/alexandrio`.

---

## 1. Narration generation (server)

### 1.1 TTSQueue job — `lib/tts-queue.js`

| From | Event | To | Code |
|---|---|---|---|
| — | `enqueue`, no live job for the output path | queued | `enqueue` |
| — | `enqueue`, a live job exists | (joins: claim added to the existing job) | `enqueue`, `claim` |
| — | `enqueue`, the job for that path has `_cancelRequested` | waits for it to settle, then looks again | `enqueue` (fix #56) |
| queued | `_drain` → `_processJob` | generating | `_drain` |
| generating | output reused, or rendered and published | complete (kept, up to 500) | `_processJob`, `_onJobComplete` |
| generating | error that is not a cancel | error (kept) | `_processJob` catch |
| queued | `cancel` | cancelled (removed from `_jobs`) | `cancel` |
| generating | `cancel` | `_cancelRequested`, abort → cancelled, output deleted, emits `settled` only | `cancel`, `_processJob` catch |
| any | `suspend` (shutdown) | frozen: `_drain` does nothing | `suspend` |

**Invariants**
- At most one live job per output path (`_jobsByOutputPath`).
- A job that is being cancelled takes no new owners. `claim()` refuses it; `enqueue` waits for it to settle.
- A temp file is unique per writer (`<out>.<pid>.<rand>.<n>.part[.ext]`) and is renamed into place. A final file is never truncated.
- Temp files of dead PIDs are swept at startup (`lib/abandoned-temp-files.js`).

### 1.2 GenerationScheduler item — `lib/generation-scheduler.js`

The item moves pending → started → settled. Cancelling a pending item rejects it. Cancelling a started item only aborts it: the item keeps its capacity slot until it settles.

**Invariant:** `active.length ≤ capacity`.

### 1.3 ChunkedTTS chunk and plan — `lib/chunked-tts.js`

**Chunk status**

| From | Event | To |
|---|---|---|
| — | manifest build | ready if the file exists, else pending |
| pending | `_materializeChunkNow` | queued (with job id in `_jobMap`) |
| queued | queue `progress` | generating |
| queued / generating | `complete` | ready |
| queued / generating | `job-error` | error, plan halted |
| queued / generating | queue `settled` with status cancelled | pending; pumped only if the plan still has claims (`_onJobSettled`, fix #56) |
| queued / generating | job missing during a pump | pending, or ready if the file is on disk |
| queued | rebalance | pending (the job is forgotten before it is cancelled) |
| ready | evicted from the cache while the manifest is loaded | pending |
| ready | `invalidateCachedChunk` | pending |

**Plan state**
- Flags: `halted`, `cancelled`, `waitingForCapacity`, plus the claim set `_generation.claims`.
- Manifest lifecycle: build, resume or replace, then delete (idle eviction, `quiesceChapter`, `cancelBook`).
- Locks: `manifestBuilds` per chapter path, the `_pumpPromise` chain, `_reconcileInFlight`, `inFlightSplitPlans`.
- Guards: `_bookEpochs` and `_deletedBooks`, plus `_retiredRequestIds`. That is now a Map from id to the time it was retired; unreferenced ids are pruned after 1 h.
- Timers: `reconcile` every 20 s; `waitForChapter` checks liveness every 15 s, up to 4 recoveries.

**Invariants**
- Claims live in two layers, the plan (`_generation.claims` and the journal) and the queue. Release them only through `releaseClaimsWhere(matcher, { peers })`. It removes plan claims on every worker and peer, then cancels the queue claims. Calling `ttsQueue.cancelWhere` directly is forbidden; a test fails if `server.js` does it.
- `reconcile` pumps only plans that hold at least one claim.
- A plan whose narration text was read before the last `quiesceChapter` (a per-chapter text epoch) aborts. It never installs a manifest or writes a text hash (#63).

### 1.4 Generation journal `chapterJobs` — `lib/generation-journal.js`

| From | Event | To |
|---|---|---|
| absent | `putChapter` | pending |
| pending | `recordChapterFailure`, transient | retryable |
| pending / retryable | third failure, or a permanent error | quarantined |
| quarantined | `putChapter` | throws (blocked) |
| quarantined | retry route | cleared |
| any | chapter complete, or last claim removed | removed |
| restart | — | claims from transient origins dropped |

### 1.5 Chapter prepare record — `server.js` `ensureChapterAudioPrepared`

A record is created, gains consumers, and aborts when the last consumer leaves. It is deleted in its own `finally`, which checks that it still owns the key.

**Invariant:** a new caller never joins a record whose `controller.signal.aborted` is true; it starts a new record instead (fix #56).

### 1.6 Child processes and runtimes

| Machine | State | Guard |
|---|---|---|
| Chatterbox (`narration-runtime.js`) | generation counter, `stopping`, start promise, restart and stable timers | `child ===` and generation checks on exit |
| MOSS Nano (`moss-nano-lifecycle.js`) | `child`, `starting`, `generation` | generation check |
| Local supervisor (`local-service-runtime.js`) | `child`, `restarting`, `stopped`, `pendingSignature` | — (dev only; see open item O-G3) |
| Rebuild promotion (`chapter-audio-reconcile.js`) | `.rebuild-audio-*.json` with `phase: 'promoting'` | rolled forward or back on start |

---

## 2. Playback serving (server)

### 2.1 HLS session — `lib/hls-audio-stream.js`

| From | Event | To |
|---|---|---|
| — | first playlist request after admission passes | PREPARING |
| PREPARING | source ready, ffmpeg spawned | ENCODING |
| ENCODING | `index.m3u8` size > 0 | READY |
| PREPARING / ENCODING | 60 s timeout, or failure before ready | FAILED + EVICTED; the next poll rebuilds |
| READY | encoded lead past the highest fetched segment > `XANDRIO_HLS_MAX_LEAD_SECONDS` (default 300 s) | HELD (input feed paused; still counts as running) |
| HELD | listener fetches further | READY (feed resumes) |
| READY | input or encoder fails | FAILED-READY: the key is remembered as failed and the playlist answers 410 (fix #59) |
| FAILED-READY key | same owner opens another stream | key forgotten |
| READY | encoder exits 0 | COMPLETED |
| not ready, last waiter disconnects | — | EVICTED |
| any | owner replaced / account cap / LRU / storage over 4 GiB after a 2-min lease / capacity reclaim of the longest-away HELD session / dispose | EVICTED, directory removed |
| READY and running | evicted for any reason except shutdown | key remembered as failed, and the playlist answers 410 (#63) |

**Invariants**
- One session per key and per owner.
- At most 16 active sessions, 4 per account, and 12 created per account per minute.
- An EVENT playlist only appends; a ready session is never rebuilt under the same URL.
- Chunks more than 120 s ahead of the listener are requested at `lookahead` priority, not `immediate`.

### 2.2 Continuous timeline — `lib/playback-orchestrator.js` `continuousTimelines`

- Keyed by `sessionId` and replaced on each prepare. Measured durations carry over when the book and start chapter match. Entries are pruned after 12 h.
- A resume is accepted only when the start chapter is unmeasured or long enough to contain the resume point.
- **Invariant:** only the newest, unaborted prepare for a `sessionId` may register its timeline. Each prepare gets a token, and the HLS route passes the abort signal (fix #59).
- A Range reconnect the timeline cannot prove gets 410 (`requireResume`), never a 200 replay. The player reloads at its own position (#63).
- Each chapter `iterateInputs` enters is held out of the cache sweep (`holdForPlayback`) until the stream leaves it, ends, or aborts (#63).

### 2.3 Transport response — `lib/chapter-audio-stream.js`

The response moves NEW → headers sent (200 with `Accept-Ranges: none`, or 206 for a proven resume) → STREAMING → ended, destroyed or aborted. Cleanup runs in `finally`.

`skipState` holds the decode start plus any resume that has not been applied yet. It is reduced by the seek preroll, retried once on EOF, and set to zero at the last input of the start chapter.

- HEAD returns headers only and never starts an encode.
- The MP3 header probe caches success only. A failure retries with backoff.
- File responses carry a strong ETag and Last-Modified, and `If-Range` is honoured (#63).

### 2.4 `waitForChunk` waiter — orchestrator

WAITING resolves when the chunk is ready. It rejects on a chunk error, on halted-and-pending, when the chapter or book is cancelled, or on abort. All listeners are removed when it settles.

### 2.5 Position record — `lib/user-library-state.js` `recordPosition`

The order key is `updatedAtMs`. It is capped at the server's now, on both the incoming and the stored stamp (fix #61).

A write is rejected in two cases:
- It is older than the stored stamp.
- It moves backward without `allowBackward`.

`finished` stays set unless `allowBackward` is passed.

### 2.6 Other

| Machine | State |
|---|---|
| Rate-limit buckets (`rate-limit.js`) | fixed window per group and IP |
| Playback health (`playback-health.js`) | daily counters per platform, 35-day retention |
| Premium prep | generating, paused, engineOffline, ready, error, idle, userPaused or disabled, plus `desiredState` |
| Artifact provenance | null, legacy-unverified, verified or invalid |
| Cache eviction | 48 h protection; skipped while the manifest is loaded |

---

## 3. Playback client — `public/js/single-file-chapter-player.js`, `public/app.js`

### 3.1 Engine source lifecycle

| From | Event | To |
|---|---|---|
| any | `loadChapter` | loading (`gen++`, ready source cleared, `_pendingChapterTime` set) |
| loading | metadata or canplay | ready (`_commitReadySource`, `_pendingChapterTime` cleared) |
| loading | runway or media error | failed (the error carries `chapterIndex` and `chapterTime`) |
| loading | newer load, `cancelPendingLoad`, or dispose | cancelled (generation mismatch) |
| ready (continuous) | seek outside the buffer, or end-chapter change | relocating (`gen++`, `_pendingChapterTime` = target) |
| ready (finite) | `ended` with a pre-warm ready | ready N+1 (gapless) |
| ready (finite) | `ended` with a pre-warm in flight | awaiting boundary |
| awaiting boundary | blob arrives, timeout, or `play()` | ready N+1 (`play()` targets `_nextPlayableChapterIndex()`), or the ordinary ended path |
| ready (continuous) | `ended` at the end-chapter limit | ready source cleared, `continuous-limit` |

**Invariants**
- Every await is followed by a generation check.
- `ownsReadySource` gates play.
- `getCurrentTime()` and `getPosition()` describe `chapterIndex`. While a load is pending they report the pending chapter's start offset, never the previous source's time (fix #57).

### 3.2 Engine play intent

- State: `_isPlaying`, `_playRevision`, `_pauseReason`, plus `audio.paused` and `audio.ended`.
- **Invariant:** the progress baseline is at or before the real start position. On an ended element the baseline is 0 (fix #57).

### 3.3 Watchdogs and pre-warm

- **Stall probe:** reports `MEDIA_STALLED` once.
- **Stream-regression latch:** reports `MEDIA_STREAM_RESET` once, and resets on a seek or a new source.
- **Pre-warm:** one attempt per chapter, gated by `_stopsAtCurrentChapter` (reads `endChapterIndex`).
- **Invariant:** `endChapterIndex` follows the sleep timer for finite and continuous sources alike (fix #57).

### 3.4 App recovery lineage

- State: `recoveryToken`, `automaticRecovery*` (at most 2), `manualRecoveryInFlight`, `waitingForOnline`, `waitingForServer`, `recoverySnapshot`, `rateLimitedUntil`.
- Flow: `handleChunkError` → automatic attempts (a 429 card, an offline wait, 250·2ⁿ ms backoff, or a server wait) → manual: prepare, then a tap.
- Reset by `cancelPlaybackRecovery` on navigation, pause or seek.
- `CHAPTER_ADVANCE_NOT_ALLOWED` goes to the resume prompt, not to the failure card.
- **Invariant:** a snapshot pairs `currentChapter` with that chapter's own time. `selectedChapterTime()` returns engine time only when `chunkPlayer.chapterIndex === currentChapter`; otherwise it returns 0 (fix #57).

### 3.5 App load ownership

- Tokens: `openBookToken`, `loadChapterToken`, `chapterLoadIntent`, `resumePauseRevision`, `audioEndOwner`.
- Latest wins after every await.
- **Invariant:** a superseded or cancelled load returns `{loaded:false, reason:'stale'}`. It is never an open failure, so a pause during `openBook` keeps the new book selected (fix #57).

### 3.6 Session, status, sleep timer, lifecycle

| Machine | Behaviour |
|---|---|
| `playback-session.js` | `buildCheckpoint` returns null while a transition is pending, or when the engine does not own the selected chapter |
| `player-status.mjs` | idle, preparing, ready, failed or engine-starting |
| Sleep timer | mode null, `time` or `chapter`. A chapter stop (finite or continuous) moves the selection to the next playable chapter (`settleSleepTimerChapterStop`) |
| Page lifecycle | hidden or pagehide → checkpoint → beacon. Heartbeat carries an `ended` flag. The smart-rewind anchor is written on pause and read once |

---

## 4. Offline audio

### 4.1 Client IndexedDB title, chapter and block — `public/js/offline-store.js`

**Title record and `active` pointer**
- `saveJob` → staged. The pointer moves unless a `full`+`ready` title would be replaced by an incomplete one.
- `finalizeTitle` → the pointer moves to the target, and other revisions are deleted.
- `deleteTitle` → the title epoch goes up by one and a tombstone is written. `reviveTitle` removes the tombstone on user intent.

**Chapter row:** `putChapter` → pending. It stays ready only for the same artifact if that was already ready. A block write or block delete on the artifact sets the row to pending. `markChapterReady` (all blocks verified and the right size) sets ready.

**Block:** `putPendingBlock` → pending with a write id. A matching hash with the same write id → verified. A failed hash → deleted.

**Lease and fence:** one global 15 s lease, renewed every 5 s. Every write checks the lease and scope epochs, the title epoch, and the tombstone.

**Fence errors and shared blocks (#63)**
- Fence failures carry codes: `OFFLINE_LEASE_LOST`, `OFFLINE_FENCE_STALE`, `OFFLINE_TITLE_DELETED`, `OFFLINE_TITLE_STALE`.
- `saveTitle({requireActive})` refuses a revision the active pointer no longer names.
- `markChapterReady` restores every row of a verified artifact, across books.
- A verified block is never rewritten.

### 4.2 Client device job — `public/js/features/offline-device.mjs`

| From | Event | To |
|---|---|---|
| — | `start` | preparing (`autoResume`) |
| preparing | no ready candidates | preparing (polls every 1.5 s) |
| preparing / downloading | chapter transferred | downloading |
| all complete | probe fails | verifying (up to 4 tries) |
| all complete | probe passes | ready or partial → finalize, job deleted |
| any | the store throws `OFFLINE_LEASE_LOST` (another tab took the lease) | interrupted, `LEASE_LOST`, resumable. Other fence codes are not retried (fix #58, #63) |
| any | other error | named by `transferState`, `autoResume` from `resumableError` |
| any | `DESCRIPTOR_CHANGED` or `TRANSFER_CONTRACT` | refresh; at most 8 refreshes without progress, and only while the manifest revision changes (`descriptorRefreshes`) |
| any | pause / remove | paused / deleted |

**Invariants**
- The stored job entry never carries `replacement`.
- `replacement.storageRevision` is used only while the base is a ready full download and its revision differs from the base revision.
- Hydrate ignores a stale replacement and heals the in-memory snapshot (fix #58).
- The posted preparation intent is keyed by `full` or `rolling:<indexes>`. `ensureIntent` re-posts until the key matches the job's current key (fix #58).

### 4.3 Server preparation and package

- **Preparation intent:** not-requested → preparing → ready, error or paused, or removed. Changes are serialized by `mutate` and guarded by `requestId`.
- **Package:** a mutable per-chapter sidecar becomes an immutable `_sha256-<digest>.mp3`. Jobs are deduplicated per identity and per chapter. The disk evictor skips `_offline_` files.
- **Manifest:** `sourceRevision` covers text, variant and recipe. `revision`, a digest of the body, is used as the ETag. A transfer sends `If-Range` + `&artifact=`; a changed artifact gets 409 → `DESCRIPTOR_CHANGED`.

### 4.4 CacheStorage downloader and service worker

- CacheStorage downloader (`offline.js`, the default path): repairing → ready, verifying or incomplete. The audit and prune pass sets ready → incomplete.
- Service worker shell cache `xandrio-v<N>`: it keeps the previous shell and drops the others. Audio and title caches are kept.

---

## 5. Book lifecycle, locks and accounts

### 5.1 Import job — `server.js` `createImportJob`

The job lives in memory only, so a restart drops it by design.

| From | Event | To |
|---|---|---|
| — | POST download or upload | running(1) |
| — | primary id already exists | 409 + `existingBookId`; the book goes back on the shelf (fix #62) |
| running | `progress(n)` | running(n) |
| running | cancel, only while step < 7 | `cancellationRequested` → throws at the next progress → cancelled |
| running | success / error | complete / failed |
| terminal | 30 s SSE grace / 30 min TTL | closed / deleted |

**Invariants**
- An import never writes over, owns or deletes a live book's files. The importer re-checks the primary id before it normalizes anything.
- The dedupe check and `createImportJob` run with no await between them.
- The importer owns a downloaded file from the moment `acquire` returns. Ownership moves to the final path after the rename (fix #62).
- Before its first write to `cache/`, an import claims its paths in a PID-tagged marker in `DATA_DIR/import-claims/`. The marker is removed on commit or after a full cleanup. At start, a marker whose owner is dead is swept. A listed path is deleted only if `books.json` is readable and no record refers to it (#63).

### 5.2 Book mutation and state lock — `lib/book-mutation-lock.js`

- One FIFO queue per book id.
- Reentrancy uses AsyncLocalStorage. Each held key carries a `{released}` token that the lock's `finally` sets.
- **Invariant:** reentrancy applies only while the holder is still inside its critical section. Timers and detached work that outlive it queue like any other caller (fix #61).
- A waiter that passes `{ signal }` rejects on abort and leaves the queue.
- Lock waits made on behalf of abortable work must pass the signal.

### 5.3 Deletion

- **Transaction** (`book-deletion-log.js`): `begin` → pending[token]; `commit` → deletions[id] plus a revision; `abort` drops the token.
- **Reconcile:** a pending token whose book is absent becomes a deletion; one whose book is present is dropped. Reconcile skips tokens that are active in this process.
- **Commit:** records the deletion from its own book id even if the pending entry is gone (fix #61).
- **Tombstone `deletedBookIds`** and sweeps at 2, 10 and 30 s. Sweeps take the book lock for real (see 5.2).
- Each tombstone holds a token per deletion. A sweep clears it only if its token is still current (#63).
- The feed (`listSince`) leaves out a deletion when the catalog record's `addedAt` is later than `deletedAt`. Both stamps use the server clock (#63).
- **Deletion grammar** (`book-artifact-paths.js`) includes TTS and concat `.part` temps.

### 5.4 Chapter rebuild journal — `lib/chapter-rebuild.js`

The journal moves: prepared → snapshotted → per store (started, then completed) → committedAt → audioCompletedAt → removed.

Recovery rolls back before the commit and rolls forward after it. It runs when the journal is opened and at startup.

Only a rebuild of the same book counts as busy; other lock holders are waited for. The route answers 409 `REBUILD_IN_PROGRESS` or `REBUILD_RECOVERY_PENDING`, never a false "up to date" (#63).

### 5.5 Study-guide job — `lib/book-guide-service.js`

| From | Event | To |
|---|---|---|
| — | start | pending |
| pending | slot free | running(attempt) |
| running | success / failure / cancel | ready / failed / cancelled |
| pending | cancel | cancelled |
| restart | — | pending or running → pending, or → failed |

**Invariant:** `sourceForBook` and `start()` honour the job's AbortSignal. Cancelling while DELETE holds the book lock therefore always finishes (fix #61).

### 5.6 Session and account — `lib/auth.js`, `lib/accounts.js`

- **Session:** created (it records the `credentialEpoch` of the account record that was verified) → touched → destroyed or expired.
- **Account:** created → password changed (`credentialEpoch + 1`) or rehashed on login → disabled or enabled.

**Invariants**
- A request is refused when its session's epoch differs from the account's (default 0).
- A login rehash is written only if the stored hash is still the verified one.
- A self password change succeeds only at the verified epoch (fix #60).

---

## 6. Ledger: reachable invalid states

Severity: H = data loss, wrong position or wasted compute for everyone; M = narrow window or behind a flag; L = leak or cosmetic. Every fixed item has a regression test that failed before its fix. Rows 1–28 come from the first audit pass (#56–#62). Rows 29–46 are the candidates from #63, confirmed and fixed in the second pass. Rows 47–89 come from the third pass (2026-11-08), which looked for invariants the code relied on but did not enforce. Those rows have no issue number. The commit is the reference.

| # | Area | Invalid state or transition | Sev | Issue | Status |
|---|---|---|---|---|---|
| 1 | import | Re-importing an owned book overwrites, then on cancel or failure deletes, its live files | H | #62 | fixed `6f3cec1` |
| 2 | import | Cancel during download leaks the downloaded file | M | #62 | fixed `6f3cec1` |
| 3 | generation | `.part` temps of dead processes never swept | L | #62 | fixed `6f3cec1` |
| 4 | generation | Cancelled lookahead or offline work restarts via `reconcile` (stale plan claims) | H | #56 | fixed `bc5350d` |
| 5 | generation | New caller joins a job that is being cancelled → `Job cancelled`, chunk stuck | M | #56 | fixed `bc5350d` |
| 6 | generation | Prepare record joined after abort → "intent was retired" | L | #56 | fixed `bc5350d` |
| 7 | generation | `_jobMap` and `_retiredRequestIds` grow without bound | L | #56 | fixed `bc5350d` |
| 8 | client | Play on an ended finite source → false `MEDIA_PROGRESS_TIMEOUT` reconnect; finished chapter replays | H | #57 | fixed `6036404`, `f7993fb` |
| 9 | client | Failed chapter switch → Retry opens the new chapter at the old chapter's offset | H | #57 | fixed `6036404`, `f7993fb` |
| 10 | client | Pause during `openBook` load → reverts to the previous book | M | #57 | fixed `f7993fb` |
| 11 | client | After a continuous sleep stop, Play pairs chapter C+1 with C's time | M | #57 | fixed `f7993fb` |
| 12 | client | Stale `endChapterIndex` disables gapless pre-warm on downloaded books | M | #57 | fixed `f7993fb` |
| 13 | client | `CHAPTER_ADVANCE_NOT_ALLOWED` shows the failure card | L | #57 | fixed `f7993fb` |
| 14 | client | Boundary-wait `play()` targets `chapterIndex+1`, not the next playable chapter | L | #57 | fixed `6036404` |
| 15 | offline (flag) | Stale `replacement` → the next update overwrites ready rows → 504 offline | M | #58 | fixed `38929f7` |
| 16 | offline (flag) | Stale replacement → auto-resume job on every launch | M | #58 | fixed `38929f7` |
| 17 | offline (flag) | Mode or window change never re-posts intent → polls forever holding the lease | M | #58 | fixed `38929f7` |
| 18 | offline (flag) | Lease taken by another tab → permanent `STORAGE_FAILED` | M | #58 | fixed `38929f7` |
| 19 | HLS | Paused listener keeps generating at `immediate` priority for hours | H | #59 | fixed `0c03040` |
| 20 | HLS | Failed ready session silently rebuilt from its original offset under the same URL | M | #59 | fixed `0c03040` |
| 21 | HLS | Abandoned prepare overwrites the live timeline | M | #59 | fixed `0c03040` |
| 22 | auth | Login rehash reverts a concurrent password change or reset | M | #60 | fixed `63d2977` |
| 23 | auth | Session created by a login that raced a reset survives the reset | M | #60 | fixed `63d2977` |
| 24 | auth | Self password change overwrites a concurrent admin reset | M | #60 | fixed `63d2977` |
| 25 | locks | Lock reentrancy leaks into timers → delete sweeps bypass the lock | M | #61 | fixed `5440a62` |
| 26 | locks | DELETE deadlocks behind its own study guide; guide queue stalls | M | #61 | fixed `5440a62` |
| 27 | deletion | Concurrent feed read drops the pending token → deletion lost from the feed | M | #61 | fixed `fc99ef9` |
| 28 | sync | Device clock up to 5 min fast blocks newer progress from other devices | M | #61 | fixed `15e0d7c` |

| 29 | generation | A pronunciation repair during a first-time generation installs a manifest built from the old text. `quiesceChapter` now bumps a per-chapter text epoch even with no manifest, and a stale build aborts | M | #63 | fixed `0f4eaf3` |
| 30 | dev runtime | The local supervisor relaunches before the old server exits (EADDRINUSE), and its 10 s stop can kill engine cleanup. The stop timeout is now the shutdown timeout + 5 s, and it waits for the exit | L | #63 | fixed `f8b93b3` |
| 31 | cache | A continuous or HLS stream protects only its start chapter, so a sweep evicts later chapters while they play. `iterateInputs` now holds each chapter it enters (`holdForPlayback`) | M | #63 | fixed `5a36911` |
| 32 | streaming | An unprovable Range reconnect gets a 200 full stream; Chromium downloads and discards N bytes, and recovery waits for the 20 s watchdog. It now gets 410, and the player reloads at its own position. Not 416: Chromium treats 416 as EOF | M | #63 | fixed `c851ec6` |
| 33 | streaming | A failed MP3 header probe is cached as null, which disables resume for the process. Failures now retry with backoff (5 s → 5 min) and a 10 s probe timeout | L | #63 | fixed `c851ec6` |
| 34 | streaming | `HEAD /api/audio-continuous` (Express routes HEAD to GET) runs the full paced encode. HEAD now returns the headers only | L | #63 | fixed `c851ec6` |
| 35 | HLS | A ready session evicted for the account cap is rebuilt from its original offset, and that rebuild also evicted the other device's live stream. Eviction of a ready, running session now records the key as failed (410) | M | #63 | fixed `b374adb` |
| 36 | sync (client) | A fast or slow device clock decides `chooseFreshestPosition`. Checkpoints are now stamped with `serverNow()`, using the offset learned from response `Date` headers | M | #63 | fixed `d8f60b1` |
| 37 | offline (flag) | A second `DESCRIPTOR_CHANGED` in one session ends the job in `refreshing`. Up to 8 refreshes are now allowed while the revision changes, and the count resets on progress | M | #63 | fixed `9917423` |
| 38 | offline (flag) | A shared artifact's block write demotes another book's ready rows → 504. `markChapterReady` now restores every verified row, and verified blocks are not rewritten | M | #63 | fixed `9917423` |
| 39 | offline (flag) | A stale tab's `invalidateChapter` writes an orphan old revision and moves the active pointer. `saveTitle({requireActive})` now throws `OFFLINE_TITLE_STALE` | M | #63 | fixed `9917423` |
| 40 | offline (flag) | Lease loss is classified by error text. The store now throws coded errors (`OFFLINE_LEASE_LOST`, `OFFLINE_FENCE_STALE`, `OFFLINE_TITLE_DELETED`, `OFFLINE_TITLE_STALE`) | L | #63 | fixed `9917423` |
| 41 | offline | A DELETE that races a re-POST before the first persist dereferences a null record → 500 | L | #63 | fixed `5f43a23` |
| 42 | deletion | The first delete's last sweep clears the tombstone of a later delete of the same id. Tombstones are now tokens per deletion | M | #63 | fixed `977b539` |
| 43 | rebuild | Rebuild reports "already up to date" when `GET /api/book` holds the lock. Busy now means another rebuild of the same book; the route answers 409 | L | #63 | fixed `ecde65f` |
| 44 | deletion | An old deletion-feed entry deletes a re-imported book's new offline copy. `listSince` now drops a deletion superseded by a later `addedAt` | M | #63 | fixed `804f4a9` |
| 45 | import | A crash mid-import leaves `cache/<id>.*` with no record. PID-tagged import claims (`lib/import-claims.js`) are now swept at start. A path is deleted only if its claim owner is dead, `books.json` is readable, and no record refers to it | L | #63 | fixed `ac25e46` |
| 46 | streaming | Fixed-path chapter audio (`/api/audio`, `/api/audio-ios`, the stream fallback) had no validator, so an `If-Range` resume across a rewrite could splice encodes. A strong ETag and Last-Modified are now sent, and `If-Range` is honoured | L | #63 | partly fixed `f4429ea`; see O-S3 |
| 47 | dedupe | A title test divided by the smaller token set, and the work key dropped subtitles, so "Dune Messiah" was refused as a duplicate of "Dune" | H | — | fixed `c23d017` |
| 48 | narration | The Roman chapter-marker rule ran again on each sentence, so "I—I froze" was read as "one—I froze" | H | — | fixed `9868278` |
| 49 | narration | An unspeakable block merged into a chunk, then the speakable filter dropped the merged chunk, prose included | H | — | fixed `dcd93ca` |
| 50 | generation | The truncation check counted end padding as speech (all engines except Nano), and had no upper bound | H | — | fixed `4fbe7d6` |
| 51 | client | The `CACHE_VERSION` guard read only `git diff HEAD`, so it passed on every clean tree; `9917423` never reached installed apps. The guard now checks a content fingerprint of `APP_SHELL` | H | — | fixed `3738c2c` |
| 52 | narration | Coalescing could exceed the split policy's length limit (595 chars at 280) | L | — | fixed `2ff9fc8` |
| 53 | narration | The heading cue replaced the first mention of the heading text, not the heading | L | — | fixed `e99315c` |
| 54 | narration | The page-cite rule read "Fed. R. Civ. P. 12" as a page | L | — | fixed `2678e9a` |
| 55 | generation | An unprobeable take was accepted and marked verified; a failed marker publish left an unmarked chunk | L | — | fixed `4fbe7d6` |
| 56 | generation | Chunk durations came from file size (+~94 ms per chunk), so seeks drifted against the stitched file | M | — | fixed `1c84c3c` |
| 57 | cache | The variant key omitted sampling, gain, model and pause overrides. Defaults keep their keys byte for byte; the voice tuning sidecar is compared through the marker | M | — | fixed `6c2d4c8` |
| 58 | cache | A failed `.texthash` write was swallowed; stitched chapter files outlived an invalidated chunk | M | — | fixed `880cc81` |
| 59 | rebuild | Rebuild reuse accepted only v1 markers, while producers write v2 | M | — | fixed `eb99939` |
| 60 | generation | Startup replayed journal entries for deleted books and out-of-range chapters | M | — | fixed `5dab756` |
| 61 | sync | A position or bookmark outside the book (index ≥ `chapterCount`, timestamp in ms, `"1e300"`) was stored and froze forward-only progress | M | — | fixed `ab58bf6`, `55f93e2` |
| 62 | sync | An unmappable position from an earlier chapter layout blocked every forward-only write | M | — | fixed `ebfaed5` |
| 63 | bookmarks | Bookmarks from an earlier layout were served unfiltered; they are now flagged `stale` and not seekable | L | — | fixed `ed1e64f` |
| 64 | structure | Text moving between chapters under the same structure key kept positions on the old text | M | — | fixed `449d573` |
| 65 | streaming | A live stream continued across a rebuild, a re-chunk or a narrator change; it now ends with 410 and the client reloads | M | — | fixed `78466ca` |
| 66 | streaming | Carried timeline durations were not tied to the narrator, structure or text epoch; timelines were keyed by session id alone | M | — | fixed `78466ca` |
| 67 | streaming | A reconnect past the 24 h horizon got a 200 replay instead of 410 | M | — | fixed `4191db1` |
| 68 | streaming | A non-LSF MP3 bitrate broke the frame math | L | — | fixed `0f64143` |
| 69 | streaming | The 0-byte chunk guard deleted the file but kept the manifest entry; quarantine used the wrong tier | L | — | fixed `547c917` |
| 70 | cache | Audio use was recorded for any `/api/audio-*` path before routing; a save also erased the stored history | M | — | fixed `35cdad6` |
| 71 | import | The book id was the client's hash, with no tie to the bytes or the provider | M | — | fixed `c50eb52`, `b2bd22f` |
| 72 | import | The EPUB size guard trusted declared sizes and passed ZIP64 | M | — | fixed `c76d429` |
| 73 | import | pdf-parse and pdf.js ran in-process with no deadline or heap cap | M | — | fixed `ea6d095` |
| 74 | extraction | Same-named spine files in different folders collided | M | — | fixed `1faea2b` |
| 75 | extraction | Same-file TOC anchors out of document order were narrated twice, or dropped the file head | M | — | fixed `bc0448f` |
| 76 | metadata | EPUB metadata strings had no length cap | M | — | fixed `e5e69de` |
| 77 | metadata | Remote enrichment was used without a title or author match | M | — | fixed `8c16fe8` |
| 78 | search | OPDS and IA ids collided after sanitizing, or exceeded 128 chars; the OPDS entry scan was quadratic | L | — | fixed `8d9ae58`, `12d2a20` |
| 79 | accounts | The last-admin check ran outside the store update | L | — | fixed `6e33deb` |
| 80 | accounts | Account ids were not validated as sync ids; an invalid id fell back to `default` | L | — | fixed `b87504a` |
| 81 | auth | Owner checks used `role !== 'member'` (fails open); offline preparation skipped the member gate | L | — | fixed `f506713` |
| 82 | runtime | No lock held one server per `DATA_DIR`; startup recovery could roll back a live rebuild | M | — | fixed `4c775d9`, `ccc32ce` |
| 83 | runtime | An empty or wrong `DATA_DIR` in production gave everyone admin (trusted-LAN) and still passed `/ready` | H | — | fixed `a15e7f0`, `ccc32ce` |
| 84 | deploy | Rollback ran an older release on newer data; there is now `DATA_DIR/format-version` | M | — | fixed `4c775d9`, `ccc32ce` |
| 85 | rebuild | Rebuild journals and backups outlived their book and could replay onto a re-import; journal versions were never read | M | — | fixed `8139dd5` |
| 86 | persistence | Rebuild bypassed the critical books store; temp names repeated across PIDs; no directory fsync; xbook cache keyed on mtime and size | L | — | fixed `9a5e5c9`, `8b72373`, `6f8ef6b` |
| 87 | deletion | One failed library-state step left the others behind | L | — | fixed `d75969d` |
| 88 | runtime | Node, ffmpeg and ffprobe were never checked; trust-proxy misconfiguration was silent | L | — | fixed `4c775d9`, `4cee8b4` |
| 89 | client | Device-local checkpoints were shared across accounts; stale clients could not be detected | M | — | fixed `fc7ba5d`, `5a71248` |
| 90 | import | pdf-parse never ran: it shared a thread with the pdfjs 6 outline reader and failed its pdfjs 5 version check. Each parse now has its own worker, so the pdf-parse candidate competes again and can change the chapters of new PDF imports (owner approved, was O-I6) | M | — | fixed |
| 91 | persistence | A corrupt positions, shelves, bookmarks, queues, users, client settings, settings, pronunciations, deletion log or cloned-voice file was read as defaults and then overwritten; a deleted one started empty. These are now registered critical stores: reads and writes throw, the bytes are kept, and `/ready` fails | H | — | fixed `93dbd04`, `f0a0606` |
| 92 | persistence | One malformed `book-guide-jobs.json` entry made startup restore throw (boot loop). Malformed entries are skipped, logged and dropped on the next write | H | — | fixed `2be409e` |
| 93 | deletion | The deletion revision went backwards after a log restore. Revisions start above a sidecar high-water mark; the feed carries an `epoch`, and the client rereads from 0 on a lower revision or a new epoch | M | — | fixed `859a20e`, `bd8094e`, `9d81920` |
| 94 | deletion | A crash or failing step after the record commit left cache files, covers, xbooks and offline packages forever. Every step runs; a repeated DELETE finishes cleanup; a startup sweep removes files of committed deletions (readable catalog only) | H | — | fixed `99986a5` |
| 95 | deletion | Narrator pin, pronunciation rules and chapter transitions outlived the book and were inherited on re-import; also removed when the catalog is readable and empty | M | — | fixed `99986a5` |
| 96 | voices | Deleting a clone left books pinned to it; a same-name clone then narrated them. Delete and create clear the pins, and a pin to an unregistered voice is ignored | M | — | fixed `e9d6fba` |
| 97 | sync | Profile migration moved only positions and the queue, and a shallow merge dropped the source queue. All per-user stores migrate with merges that keep both sides | M | — | fixed `ca37301` |
| 98 | shelves | `addBookToShelf` wrote without the book lock or an existence check | L | — | fixed `d3a0800` |
| 99 | source policy | An unknown, non-string or incomplete `source` (or an `upload`/`calibre` alternative) downloaded from Anna's while the record named another provider. The source is resolved once; gate, fetch and provenance use the same id; a bad primary source gets 400 | H | — | fixed `dff9331` |
| 100 | auth | Calibre tokens and pairing codes survived a password reset or change and "sign out other devices". They are bound to `credentialEpoch`; sign-out-others and disable remove them | H | — | fixed `54b3f1c` |
| 101 | voices | `?voiceId=` accepted any registered voice, ignoring `XANDRIO_VOICE_PROVIDERS` (see row 115) | M | — | fixed `51f6e32` |
| 102 | boundary | `disabled: "false"` disabled an account; bad `chapterIndexes` or a non-string search `query`/`language` returned 500. All now 400 | L | — | fixed `2a8657d` |
| 103 | narration | `book.language` stayed raw (`en-US`, `EN`, `English`), so Edge ignored the chosen voice but labelled the cache with it, and Kokoro took the accent from the book. It is normalized at import, refresh and store read; mislabelled verified chunks fail their recipe fingerprint and regenerate | H | — | fixed `223ef2b` |
| 104 | narration | All-caps headings were lowercased before detection, so they got no cue or pause | L | — | fixed `ab47dad` |
| 105 | generation | The planner ignored engine text limits: `paragraph-v1` chunks under the synthesis floor failed permanently, and `hybrid-v1` chunks passed Chatterbox's output cap. Engines declare min/max text length and the planner fits them | M | — | fixed `09ca776` |
| 106 | narration | Pronunciation rules matched raw text (`don't` missed `don’t`; `Zoe` matched inside NFD `Zoë`). Matching uses NFC with quotes folded | L | — | fixed `c044e0a` |
| 107 | offline | A download played by chapter index after a rebuild or same-key text remap, and a slow server opened the old snapshot online. Local playback, Downloaded status and the online fallback require the snapshot's layout to match; the library list records every book's layout | H | — | fixed `2963f56`, `14deaf0`, `5c7b6c3` |
| 108 | sync | A device checkpoint or queued write from before a same-key text remap won over the remapped position. Positions carry `textRemapId`; the route moves pre-remap writes, ignores older ones, and moves a write without an id (pre-v231 clients) only if it was recorded before the remap | M | — | fixed `2963f56`, `de0c394`, `516d27f` |
| 109 | offline | The device clock decided whether a download outlived a deletion, and launch-time sync skipped IndexedDB titles while moving the cursor. Server import time is compared with deletion time, and sync waits for the device snapshot | M | — | fixed `9d81920` |
| 110 | client | Resetting the default speed sent null, which the server dropped while answering success. Null removes a client setting; invalid values get 400 | M | — | fixed `76a6a0f` |
| 111 | client | The Up Next auto-continue toggle sent a cached list and erased books queued elsewhere. Flag-only updates keep the list; whole-list writes need the current revision (409 when stale) | M | — | fixed `2ad0036` |
| 112 | client | The end-of-chapter timer stayed on the chapter where it was set, so after a jump it showed "End of chapter" with no limit. It follows each chapter load; a saved timer is restored only for the same chapter within 12 h | M | — | fixed `2bc9f23` |
| 113 | client | `xandrio_client_settings` and `xandrio_playback_speed` were shared by every account on a device. Both are kept per storage scope | M | — | fixed `3577b5f` |
| 114 | client | A malformed `%` escape in a deep link threw on every route attempt; it now routes to the library | L | — | fixed `10667fa` |
| 115 | voices | A book's saved narrator, and the global voice, kept sending text to a provider `XANDRIO_VOICE_PROVIDERS` excludes (was O-V1). The allowlist now outranks saved choices: an excluded pin is ignored, so the book inherits the global narrator (and regenerates audio), and startup deletes such pins; an excluded global voice falls back like a disabled Nano voice | M | — | fixed |

### Open

| ID | Item |
|---|---|
| O-I1 | Clients at v226 or older send no `X-Xandrio-Build`, so `MIN_CLIENT_BUILD` cannot reach them. It protects v227 and later only. |
| O-I2 | When a TTS engine runs on another host, Node cannot read its sampling settings. A change there does not change the variant key. `/health` reports the effective values. |
| O-I3 | `chapterTextIdentity` is recorded on a book's first open after `449d573`. A boundary shift that ships in the same deploy is not detected. |
| O-I4 | A write under an unknown old structure key is still clamped into range, not rejected. A forged key with a huge index lands on the last chapter. |
| O-I5 | The book egress proxy re-resolves hostnames, so the SSRF guard assumes a trusted proxy (documented in `29ad960`). |
| O-S3 | Media elements send no `If-Range` (confirmed in Chromium; Safari not verified). A playing element can still splice a same-length rewrite of a fixed-path chapter. A different length is rejected. A full fix needs an artifact-pinned URL (a 302 to `?artifact=`, plus 412 on a mismatch) or a new path for each rewrite. Do not ship either without an iOS device test. Low risk: it needs a rewrite of the same length during one playback. |

### Rejected (guard found; do not re-investigate)

| Area | Candidate | Guard |
|---|---|---|
| Generation | Duplicate synthesis for one path | Synchronous re-check before the job is created |
| Generation | Scheduler over capacity on cancel | A started item keeps its slot |
| Generation | Truncated finals | Unique temp file + rename |
| Generation | Stale manifest build | Build lock + `assertCurrent` |
| Generation | Delete vs. in-flight materialize | Epoch check + abort |
| Generation | Eviction while generating | Loaded manifest skipped, 48 h protection |
| Generation | Engine stop/start races | Engines stop only at shutdown |
| Generation | Waiters hanging forever | Bounded liveness recoveries |
| Streaming | HLS playlist lists unwritten segments | ffmpeg `temp_file` |
| Streaming | Range over a file that is renamed or evicted | The fd is opened first |
| Streaming | fd leaks; half-written responses | Destroy in `finally` |
| Streaming | `waitForChunk` listener leaks | Cleanup on settle |
| Streaming | Older position overwriting newer | `isOlder` |
| Streaming | Transition state never cleared | The module is pure |
| Client | Out-of-order position POSTs | Ordered by client `updatedAt` |
| Client | Position saved to the wrong chapter | `buildCheckpoint` guard |
| Client | Stale native pause events | Checks `audio.paused` |
| Client | Late `play()` rejection after a gapless swap | Generation/revision/source check |
| Client | Superseded `onReady` | Generation checks |
| Client | Parallel recoveries | Token + in-flight flags |
| Client | Pause during backoff | Token cancelled, timer cleared |
| Client | Late pre-warm | `superseded()` |
| Client | Double sleep expiry | Handles cleared |
| Client | Duplicate listeners | `DisposableScope` |
| Offline | Mixed package versions | Artifact-keyed blocks + `If-Range` + hash |
| Offline | Crash between metadata and block | Pending blocks re-verified |
| Offline | Delete during download | Epoch + tombstone |
| Offline | Account switch | Abort + `fenceScopes` |
| Offline | SW update mid-transfer | Transfers bypass the SW |
| Offline | Server eviction of packages | `_offline_` excluded |
| Book lifecycle | Delete vs. import, refresh or rebuild | Same book lock |
| Book lifecycle | Lost json-store updates | Serialized `update` + SQLite mutex + PID lock |
| Book lifecycle | Lock not released on throw | Non-rejecting tail |
| Book lifecycle | Jobs stuck running after a crash | In-memory, or restored on start |
| Book lifecycle | SSE for finished jobs | Replay + grace + TTL |
| Book lifecycle | Revoked session mid-request | `disabled` checked per request |
| Book lifecycle | Position or shelf writes after delete | `books[id]` checked under the lock |
| Generation | O-G4: `job.priority` diverging from the scheduler after a failed `prioritize()` | `prioritize` sets `job.priority` only when the promotion succeeds. The one real divergence, a claim released on a running job, holds `hasForegroundWork` for at most one chunk |
| Book lifecycle | O-B5: DELETE deadlocking behind other job cancels | None of the cancelled jobs except the study guide (fixed in row 26) takes a book lock |
