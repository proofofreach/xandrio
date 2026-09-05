const DEFAULT_SCHEDULE = Object.freeze({
  enabled: false,
  start: '23:00',
  end: '08:00',
  minutes: 30,
  mode: 'time'
});

const SUPPORTED_DURATIONS = new Set([5, 10, 15, 30, 45, 60, 90]);
const LOCAL_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function normalizeAutoSleepSchedule(source) {
  const value = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  const minutes = Number(value.minutes);

  return {
    enabled: value.enabled === true,
    start: LOCAL_TIME_PATTERN.test(value.start) ? value.start : DEFAULT_SCHEDULE.start,
    end: LOCAL_TIME_PATTERN.test(value.end) ? value.end : DEFAULT_SCHEDULE.end,
    minutes: SUPPORTED_DURATIONS.has(minutes) ? minutes : DEFAULT_SCHEDULE.minutes,
    mode: value.mode === 'chapter' ? 'chapter' : DEFAULT_SCHEDULE.mode
  };
}

export function autoSleepWindowKey(settings, date = new Date()) {
  const schedule = normalizeAutoSleepSchedule(settings);
  if (!schedule.enabled || !(date instanceof Date) || Number.isNaN(date.getTime())) return null;

  const startMinutes = timeToMinutes(schedule.start);
  const endMinutes = timeToMinutes(schedule.end);
  if (startMinutes === endMinutes) return null;

  const currentMinutes = date.getHours() * 60 + date.getMinutes();
  if (startMinutes < endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes
      ? localDateKey(date)
      : null;
  }

  if (currentMinutes >= startMinutes) return localDateKey(date);
  if (currentMinutes < endMinutes) return localDateKey(previousLocalDate(date));
  return null;
}

function timeToMinutes(value) {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

function previousLocalDate(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1);
}

function localDateKey(date) {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
