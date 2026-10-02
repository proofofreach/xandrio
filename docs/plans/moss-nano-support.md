# MOSS Nano support

## Requested outcome

Add full MOSS-TTS-Nano support, including the voice picker, to the existing self-hosted reading app. The user chose integration after seeing that the current 4-vCPU / 8 GB Hetzner VPS runs the auditioned ONNX CPU implementation approximately five times slower than Kokoro. Do not change the existing default voice or require a hardware purchase. Extend the existing product design.

The implementation starts with the 18 built-in voices in the pinned upstream manifest. A question about adding uploaded voice references is pending; built-in support is independently useful and is the default scope if the user does not request cloning. Existing Chatterbox cloning must keep working.

## Evidence and design

- `lib/tts-engine-adapters.js` owns engine dispatch, capabilities, tuning, cache identity and lifecycle composition. Add a `moss-nano` adapter before Edge's catch-all, using `moss-nano:<upstream voice name>` identities and `MOSS_NANO_*` configuration.
- `server.js` supplies the catalog and currently treats only Chatterbox as a prepared/premium engine. Generalize that classification narrowly to include Nano and its paired instant voice, preserving explicit tier requests, chapter readiness and background recovery. The existing default remains unchanged. Prefer an enabled instant provider; if none exists, serve the requested Nano voice without falsely claiming instant playback.
- `public/js/views/voices.js` owns both settings and player pickers. Extend existing provider filters, saved voices, previews, current selection, availability and preparation states. Use an explicit provider ID alongside the human label `MOSS Nano`, with a backward-compatible fallback for existing voice records. Nano belongs in the existing prepared/premium tier; describe its wait in plain language.
- The official `OpenMOSS/MOSS-TTS-Nano` CPU ONNX runtime is pinned at `8b7bcc9341b3b4ef3a3a58ba1338a7d85ff133eb`; TTS weights at `f52645cb467506d8e18e746ddd59482685b74e58`; codec at `ceff0d0749bfb3fa2d61149794ec6feef0d1e1ae`. Vendor the small runtime with its license and source record, not weights. An explicit downloader verifies every model file digest. Requests must not download models implicitly.
- A separate loopback HTTP worker serves health, built-in voice metadata and synthesis. Pin CPU dependencies and document installation/service configuration. Health remains responsive during synthesis. Serialize inference, reject unsupported voices/formats, bound request size, text tokens and generation frames/time, and observe client cancellation between generated frames. Errors or exhausted frame limits must never create successful cached audio.
- Native output is 48 kHz stereo WAV; the existing app masters it to the common playback format. Cache and render-recipe identities include Nano's model/runtime revision and rendering mode. Use a measured conservative gain, not Kokoro's gain.
- Full-waveform codec decoding hit a 3 GiB test cap and caused reclaim at 4 GiB. Use the upstream incremental codec decoder in bounded frame batches inside the worker; reset its state between requests. Verify this with actual-model audio and peak memory. Do not claim the older speed measurement proves performance of this revised service.
- Nano must share the existing local-generation scheduling slot with other local engines despite being CPU-only. Keep hardware capabilities truthful; add a separate scheduling-resource property rather than pretending Nano uses a GPU. The existing shared resource is historically named `gpu`.
- Configure optional local lifecycle start/stop/health without starting or downloading Nano for operators who have not installed/enabled it. Document `XANDRIO_VOICE_PROVIDERS` and update diagnostics, public packaging and dependency notices as needed.

## Failure cases recorded before implementation

1. A Nano voice falls through to Edge or is omitted from the provider allowlist, status API or one of the two pickers.
2. Selecting, previewing, saving or restoring a voice uses another engine; unavailable Nano gives an endless spinner or a false online state.
3. Short, long, multilingual or punctuation-heavy text is silently truncated, mis-chunked, returned empty/nonfinite, or accepted after the frame budget is exhausted.
4. Two previews, playback and background prep overlap inference or starve current playback. Cancellation leaves cache artifacts or blocks later requests.
5. Prepared Nano audio is never selected when ready; unprepared audio is falsely called ready; fallback uses a disabled provider or silently changes the selected voice.
6. Changing voice/model/runtime/output settings reuses an incompatible sample, chunk, render artifact or prepared-book recovery record.
7. Worker unavailable/restarted/disabled states fail to recover, prevent health requests, or kill an unrelated process during lifecycle cleanup.
8. Long-running CPU inference grows memory without bound or stalls the web process. Decoder state leaks between voices or requests.
9. The picker loses keyboard/touch accessibility, mobile width, saved selections or existing Edge/Kokoro/Chatterbox behavior.
10. Missing models trigger network downloads from a playback request; installation accepts corrupt or unpinned weights; packaging omits the worker or its license.

## Verification and delivery

Write the integration/E2E checks before implementation. Prefer exercising the real HTTP app and browser with a deterministic bounded engine fixture, then run a separate actual-model worker smoke test. Cover both picker surfaces, provider filtering, previews, persistent selection, prepared/fallback routing, cache identities, cancellation, offline/recovery, concurrency and malformed input. Preserve a repeatable JSON report, trace/screenshots and real audio output. Update existing fixed adapter-count assertions before code changes; do not add unit tests after implementation.

Run relevant existing regression checks and the required repository gate locally. Inspect desktop and mobile together, fix substantive issues in one batch and confirm once. Run the Impeccable detector once after UI changes. Obtain a fresh different-model implementation review, adjudicate every finding against code, then commit and push only in-scope work. Use the repository's production release operator for any production publication; a push or worker restart is not a deployment receipt. Do not incur paid GitHub Actions charges.

## Author doubts for independent review

- Does the prepared-tier fallback remain correct when only Nano is allowed, and for non-English built-in references?
- Are there hard-coded Chatterbox identities in recovery, render fingerprints, previews, diagnostics or export paths that the adapter seam does not cover?
- Is a CPU adapter sharing the existing scheduling resource sufficient when preview routes create a separate queue?
- Does bounded incremental codec decoding preserve output length and request isolation, and is frame-level cancellation sufficient to bound abandoned work?
- Can the lifecycle remain optional without stale offline status preventing the first preview or falsely promising that an uninstalled worker will start?

## Review and adjudication

Reviewer verdict: SHIP-WITH-CHANGES. All six findings verified against the cited code.

1. accepted-verified: use catalog prepared metadata; language-compatible enabled fallback; truthful premium tier when no fallback; registry-based variant recovery.
2. accepted-verified: add render identity, output format, gain, preview revision and orphan cleanup to implementation seams.
3. accepted-verified: Nano is explicitly default-off. No implicit downloads or mandatory Compose dependency. Keep its adapter definition registered for safe identity resolution even when disabled; omit its voices and reject lifecycle start (judgment-call: removing the definition would misidentify stale Nano work as Edge).
4. accepted-verified: shared resource scheduling applies independently of GPU capability, including injected production previews.
5. accepted-verified: providerId controls behavior; provider is display text only.
6. accepted-verified: built-in-only runtime, bounded streaming decode to temporary WAV, natural-EOS validation, cancellation/deadline and decoder reset in finally. Verify on actual models.

Latest user direction: use idle VPS time to prepare Nano audio. Preserve current playback priority, durable progress and completed chapters. Do not require a larger VPS. The existing scheduler yields at chunk boundaries; do not claim instantaneous interruption of an admitted chunk.

Round 2: original six blockers retired. New disabled-provider durability finding accepted-verified: recovery formerly quarantined unavailable catalog identities, cleanup only saw visible providers, and the active selection could remain hidden. Amendment: validate registered built-in identities independently of visibility; skip paused recovery without deleting its journal or audio; expose the saved unavailable selection and a temporary enabled default/instant fallback; preserve the saved preference for re-enable. Add real HTTP disable/restart/cleanup/re-enable verification with a completed chapter and partial work.

## Implementation review and final verification

The preferred Claude code gate was unavailable (`claude auth status` returned
logged out on the unrestricted host). Used a fresh `gpt-6-sol` reviewer at
`xhigh`, per model-selection's allowed different-model substitution. This does
not claim the missing Claude perspective was equivalent.

Round 1: SHIP-WITH-CHANGES.

- accepted-verified: known-uninstalled Nano could be selected. Reject it in the
  API, disable its card, and temporarily use an enabled fallback for an existing
  saved choice without overwriting that choice. Recovery is tested through HTTP.
- accepted-verified: picker health was stale after worker start. Refresh after
  selection and poll unavailable Nano while the picker is visible.
- accepted-verified: named scratch WAVs survived a killed worker. Anonymous
  temporary files now let the OS reclaim them even after a crash.
- judgment-call: retain four ONNX threads, as measured on the actual VPS, with
  worker CPU niceness +10 and shared TTS admission. The scheduler does not detect
  whole-server idleness; corrected the copy to say background preparation.
  No claim of zero interference with imports/OCR or cached playback is made.
- rejected by reviewer after checking code: fixed recovery workers already parse
  output format from their variant key before consulting the dynamic provider.
- accepted-verified: missing installation documentation. Added the referenced
  worker README with explicit installation, configuration and supervision.

Round 2: SHIP-WITH-CHANGES.

- accepted-verified: known-uninstalled chapter journals could still enter the
  shared lane. Recovery now pauses those records, and startup probes external
  Nano health before restoring journals. HTTP E2E restarts during partial prep
  with models missing and verifies no Nano call, no lost chapter, then resume.
- accepted-verified: backgrounding the tab stopped availability polling. A
  visibility-change handler resumes checks when the user returns.
- accepted-verified: the disabled-card label hid the specific missing-model
  message. Preserve the computed availability label.

The reviewer verified the anonymous-file and mastering amendments. A separate
actual-audio audit found resampling peaks after the existing limiter. Nano alone
now downmixes/resamples before limiting in both live generation and render-recipe
identity; its render version is bumped. All 18 first-take voice fixtures pass
existing loudness/peak limits. Weiguo's fixed gain includes a measured correction
for limiting; no dynamic per-chunk normalization was introduced.

The revised four-chunk VPS run produced 55.68 seconds of native speech in 48.44
seconds (0.87 real-time factor), with 1.2 GiB peak cgroup memory and no limit
hits. Decode took about 15% of generation time. These are bounded samples, not
book-length throughput or interactive-latency guarantees. The temporary VPS
worker and its files were removed; live web and Kokoro services stayed healthy.

Repeatable evidence is generated under `output/moss-nano/`: HTTP/browser report,
Playwright trace/screenshots, real-worker cancellation/isolation/EOS checks, and
18-voice mastered acoustic measurements. No model weights, raw calibration audio,
or private deployment credentials are committed.

Ratification: ENDORSED. The independent reviewer confirmed all round-2 changes.
The actual missing-model restart E2E then exposed a pre-existing assembly gap:
`premiumChapterReady` accepted recovered chunks without a complete chapter file.
It now follows the same completed-file contract as the status/playback path;
preparation assembles cached chunks without another synthesis. The expanded E2E
passes, along with the 494 server and 14 premium-preparation regression checks.

Final checks: Node 24.15.0 full suite (3,500 passed, 184 suites), browser smoke,
Nano HTTP/browser E2E (11 cases), actual-model worker smoke (5 cases), all 18
voice acoustic fixtures, existing engine acoustic fixtures, Docker context,
release declaration consistency, Python declared-dependency inventories and
syntax/diff checks. The configured high-severity dependency gate passed;
existing npm dependencies still have five moderate advisories. No dependency
versions or gate thresholds were changed for this feature.
