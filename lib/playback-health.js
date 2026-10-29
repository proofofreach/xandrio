'use strict';

// Listener-side playback health, aggregated per UTC day and device class.
//
// Clients report one summary per listening session: how long the listener
// waited for first sound, how often audio stalled, and which failures
// occurred. Reports carry no book, chapter, text, position or account
// identifier, and the server keeps only daily totals and histograms. A report
// cannot be recovered from the stored aggregate.

const REPORT_VERSION = 1;
const PLATFORMS = ['ios', 'android', 'desktop', 'other'];
const BACKENDS = ['audio-stream', 'single-file', 'unknown'];
// Upper bounds in milliseconds; the final bucket is open-ended.
const WAIT_BUCKETS_MS = [500, 1000, 2000, 4000, 8000, 15000];
const ERROR_TYPES = [
  'error',
  'stalled-timeout',
  'unexpected-ended',
  'chapter-advance-failed',
  'chapter-prewarm-failed',
  'source-reload-failed'
];
const MAX_SAMPLES = 20;
const MAX_WAIT_MS = 10 * 60 * 1000;
const MAX_SESSION_SECONDS = 24 * 60 * 60;
const MAX_COUNT = 1000;
const DEFAULT_RETENTION_DAYS = 35;

function boundedNumber(value, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.min(max, Math.round(number));
}

function boundedSamples(value) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, MAX_SAMPLES)
    .map(sample => boundedNumber(sample, MAX_WAIT_MS))
    .filter(sample => sample !== null);
}

// Returns a sanitized report, or null when the body is not a version-1 report.
// Unknown fields are dropped rather than stored.
function normalizeReport(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (body.v !== REPORT_VERSION) return null;
  const errors = {};
  if (body.errors && typeof body.errors === 'object' && !Array.isArray(body.errors)) {
    for (const type of ERROR_TYPES) {
      const count = boundedNumber(body.errors[type], MAX_COUNT);
      if (count) errors[type] = count;
    }
  }
  return {
    platform: PLATFORMS.includes(body.platform) ? body.platform : 'other',
    standalone: body.standalone === true,
    backend: BACKENDS.includes(body.backend) ? body.backend : 'unknown',
    startupMs: boundedSamples(body.startupMs),
    abandonedStartMs: boundedSamples(body.abandonedStartMs),
    boundaryWaitMs: boundedSamples(body.boundaryWaitMs),
    stalls: boundedNumber(body.stalls, MAX_COUNT) || 0,
    stallMs: boundedNumber(body.stallMs, MAX_SESSION_SECONDS * 1000) || 0,
    recoveries: boundedNumber(body.recoveries, MAX_COUNT) || 0,
    listenedSeconds: boundedNumber(body.listenedSeconds, MAX_SESSION_SECONDS) || 0,
    errors
  };
}

function emptyHistogram() {
  return new Array(WAIT_BUCKETS_MS.length + 1).fill(0);
}

function bucketIndex(ms) {
  const index = WAIT_BUCKETS_MS.findIndex(limit => ms < limit);
  return index === -1 ? WAIT_BUCKETS_MS.length : index;
}

function emptyBucket() {
  return {
    reports: 0,
    standaloneReports: 0,
    listenedSeconds: 0,
    startups: emptyHistogram(),
    abandonedStarts: emptyHistogram(),
    boundaryWaits: emptyHistogram(),
    stalls: 0,
    stallMs: 0,
    recoveries: 0,
    errors: {},
    backends: {}
  };
}

function validHistogram(value) {
  return Array.isArray(value) && value.length === WAIT_BUCKETS_MS.length + 1
    ? value.map(count => boundedNumber(count, Number.MAX_SAFE_INTEGER) || 0)
    : emptyHistogram();
}

function addReport(bucket, report) {
  bucket.reports += 1;
  if (report.standalone) bucket.standaloneReports += 1;
  bucket.listenedSeconds += report.listenedSeconds;
  bucket.startups = validHistogram(bucket.startups);
  bucket.abandonedStarts = validHistogram(bucket.abandonedStarts);
  bucket.boundaryWaits = validHistogram(bucket.boundaryWaits);
  for (const ms of report.startupMs) bucket.startups[bucketIndex(ms)] += 1;
  for (const ms of report.abandonedStartMs) bucket.abandonedStarts[bucketIndex(ms)] += 1;
  for (const ms of report.boundaryWaitMs) bucket.boundaryWaits[bucketIndex(ms)] += 1;
  bucket.stalls += report.stalls;
  bucket.stallMs += report.stallMs;
  bucket.recoveries += report.recoveries;
  for (const [type, count] of Object.entries(report.errors)) {
    bucket.errors[type] = (bucket.errors[type] || 0) + count;
  }
  bucket.backends[report.backend] = (bucket.backends[report.backend] || 0) + 1;
}

function utcDay(date) {
  return date.toISOString().slice(0, 10);
}

function hasSignal(report) {
  return report.startupMs.length > 0
    || report.abandonedStartMs.length > 0
    || report.boundaryWaitMs.length > 0
    || report.listenedSeconds > 0
    || report.stalls > 0
    || Object.keys(report.errors).length > 0;
}

// Approximate percentile from a histogram: the upper bound of the bucket that
// contains it. Returns `>15000` style labels for the open bucket.
function histogramPercentile(histogram, fraction) {
  const total = histogram.reduce((sum, count) => sum + count, 0);
  if (!total) return null;
  const target = Math.ceil(total * fraction);
  let seen = 0;
  for (let index = 0; index < histogram.length; index++) {
    seen += histogram[index];
    if (seen >= target) {
      return index < WAIT_BUCKETS_MS.length
        ? `<${WAIT_BUCKETS_MS[index]}ms`
        : `>=${WAIT_BUCKETS_MS[WAIT_BUCKETS_MS.length - 1]}ms`;
    }
  }
  return null;
}

function mergeBuckets(target, source) {
  target.reports += source.reports || 0;
  target.standaloneReports += source.standaloneReports || 0;
  target.listenedSeconds += source.listenedSeconds || 0;
  const startups = validHistogram(source.startups);
  const abandonedStarts = validHistogram(source.abandonedStarts);
  const boundaryWaits = validHistogram(source.boundaryWaits);
  startups.forEach((count, index) => { target.startups[index] += count; });
  abandonedStarts.forEach((count, index) => { target.abandonedStarts[index] += count; });
  boundaryWaits.forEach((count, index) => { target.boundaryWaits[index] += count; });
  target.stalls += source.stalls || 0;
  target.stallMs += source.stallMs || 0;
  target.recoveries += source.recoveries || 0;
  for (const [type, count] of Object.entries(source.errors || {})) {
    target.errors[type] = (target.errors[type] || 0) + count;
  }
  for (const [backend, count] of Object.entries(source.backends || {})) {
    target.backends[backend] = (target.backends[backend] || 0) + count;
  }
}

function describeBucket(bucket) {
  const listenedHours = bucket.listenedSeconds / 3600;
  return {
    reports: bucket.reports,
    standaloneReports: bucket.standaloneReports,
    listenedHours: Math.round(listenedHours * 10) / 10,
    startupMs: {
      buckets: bucket.startups,
      p50: histogramPercentile(bucket.startups, 0.5),
      p90: histogramPercentile(bucket.startups, 0.9)
    },
    // Starts the listener cancelled before hearing audio, by time waited.
    abandonedStartMs: {
      buckets: bucket.abandonedStarts,
      p50: histogramPercentile(bucket.abandonedStarts, 0.5)
    },
    boundaryWaitMs: {
      buckets: bucket.boundaryWaits,
      p50: histogramPercentile(bucket.boundaryWaits, 0.5),
      p90: histogramPercentile(bucket.boundaryWaits, 0.9)
    },
    stalls: bucket.stalls,
    stallsPerListenedHour: listenedHours > 0
      ? Math.round((bucket.stalls / listenedHours) * 10) / 10
      : null,
    stallSeconds: Math.round(bucket.stallMs / 1000),
    recoveries: bucket.recoveries,
    errors: bucket.errors,
    backends: bucket.backends
  };
}

// Pure summary over the stored day map, shared by the admin endpoint and the
// operator CLI.
function summarizePlaybackHealth(state, { days = 7, now = new Date() } = {}) {
  const cutoff = utcDay(new Date(now.getTime() - (Math.max(1, days) - 1) * 86400000));
  const byPlatform = {};
  const total = emptyBucket();
  for (const [day, platforms] of Object.entries(state?.days || {})) {
    if (day < cutoff) continue;
    for (const [platform, bucket] of Object.entries(platforms || {})) {
      byPlatform[platform] ||= emptyBucket();
      mergeBuckets(byPlatform[platform], bucket);
      mergeBuckets(total, bucket);
    }
  }
  return {
    days,
    since: cutoff,
    waitBucketsMs: WAIT_BUCKETS_MS,
    total: describeBucket(total),
    platforms: Object.fromEntries(
      Object.entries(byPlatform).map(([platform, bucket]) => [platform, describeBucket(bucket)])
    )
  };
}

function createPlaybackHealthStore({
  file,
  jsonStore,
  retentionDays = DEFAULT_RETENTION_DAYS,
  now = () => new Date()
}) {
  if (!file || !jsonStore) throw new TypeError('file and jsonStore are required');

  async function record(rawReport) {
    const report = normalizeReport(rawReport);
    if (!report) return false;
    if (!hasSignal(report)) return true;
    const current = now();
    const day = utcDay(current);
    const cutoff = utcDay(new Date(current.getTime() - retentionDays * 86400000));
    await jsonStore.update(file, state => {
      if (!state.days || typeof state.days !== 'object') state.days = {};
      for (const storedDay of Object.keys(state.days)) {
        if (storedDay < cutoff) delete state.days[storedDay];
      }
      state.days[day] ||= {};
      state.days[day][report.platform] ||= emptyBucket();
      addReport(state.days[day][report.platform], report);
    }, { days: {} });
    return true;
  }

  async function summarize(options = {}) {
    const state = await jsonStore.load(file, { days: {} });
    return summarizePlaybackHealth(state, { ...options, now: now() });
  }

  return { record, summarize };
}

function registerPlaybackHealthRoutes(app, { store }) {
  if (!store) throw new TypeError('store is required');
  app.post('/api/playback-health', async (req, res) => {
    try {
      const accepted = await store.record(req.body);
      if (!accepted) return res.status(400).json({ error: 'Invalid playback health report' });
      return res.status(204).end();
    } catch (error) {
      console.warn(`Playback health report failed: ${error.message}`);
      return res.status(500).json({ error: 'Failed to record playback health' });
    }
  });
}

module.exports = {
  REPORT_VERSION,
  WAIT_BUCKETS_MS,
  createPlaybackHealthStore,
  normalizeReport,
  registerPlaybackHealthRoutes,
  summarizePlaybackHealth
};
