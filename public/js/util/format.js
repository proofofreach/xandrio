// Pure formatting/escaping helpers shared across views.
//
// escapeHTML/safeAttr/jsString are the XSS guard for the app's
// template-string rendering — every value interpolated into innerHTML must
// pass through one of them.
import { API_BASE } from '../api.js';

// Format seconds into human-readable duration (e.g., "2h 15m", "45m", "< 1m")
export function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '';
  if (seconds < 60) return '< 1m';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

// Format seconds as a playback clock (e.g., "12:07")
export function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function formatApiDetails(details, fallback) {
  if (Array.isArray(details)) return details.filter(Boolean).join(', ');
  if (typeof details === 'string' && details.trim()) return details;
  return fallback;
}

export function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[ch]);
}

export function cleanDisplayText(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const textarea = document.createElement('textarea');
  textarea.innerHTML = raw
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|h[1-6])\s*>/gi, '\n');
  return textarea.value
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[*_`]+/g, '')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s*([•—–])\s*/g, ' $1 ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function safeAttr(value) {
  return escapeHTML(value);
}

export function jsString(value) {
  return JSON.stringify(String(value ?? ''));
}

// Relative timestamp for "last listened" lines (e.g., "2h ago", "yesterday")
export function relativeTime(dateInput) {
  const then = new Date(dateInput).getTime();
  if (!Number.isFinite(then)) return '';
  const diff = Date.now() - then;
  const min = 60 * 1000, hour = 60 * min, day = 24 * hour;
  if (diff < min) return 'just now';
  if (diff < hour) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 2 * day) return 'yesterday';
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Platform detection
export function isIOSLike() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

// Base64-encode an arbitrary JSON-serializable value for safe embedding in an
// HTML attribute (e.g., data-result) — avoids quoting/escaping issues that
// come from putting raw JSON directly into markup. decodeState is the exact
// inverse.
export function encodeState(value) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(value))));
}

export function decodeState(encoded) {
  return JSON.parse(decodeURIComponent(escape(atob(encoded))));
}

// CSS.escape wrapper with the same manual fallback used before this was
// centralized (older browsers without CSS.escape support).
export function cssEscape(value) {
  return window.CSS?.escape ? CSS.escape(String(value)) : String(value).replace(/"/g, '\\"');
}

// Inline SVG data-URI showing a book's first letter, used as the cover
// placeholder/fallback everywhere a cover image can't be shown. Colors are
// hardcoded (not var(--...)) because data URIs aren't part of the page's CSS
// cascade — chosen to visually approximate the app's existing dark cover
// placeholder + muted-letter look.
export function coverPlaceholderSrc(title) {
  const letter = escapeHTML((String(title || '').trim().charAt(0) || '?').toUpperCase());
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="#1a1f2e"/><stop offset="1" stop-color="#0d0f16"/>` +
    `</linearGradient></defs>` +
    `<rect width="100" height="100" fill="url(#g)"/>` +
    `<text x="50" y="50" fill="#94908a" font-family="system-ui,sans-serif" font-weight="800" ` +
    `font-size="40" text-anchor="middle" dominant-baseline="central">${letter}</text>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// Unified cover <img> markup with a lettered-placeholder fallback, used by
// the library grid, stats view, and the full player. Always renders an
// <img> (never a <div>) so it works even where the surrounding CSS hides
// covers without a `src` attribute. `className` carries whatever
// wrapper-specific sizing class the call site needs.
export function coverImageHTML(book, className = '', alt = '') {
  const id = String(book?.id || '');
  const hasCover = Boolean(id) && Boolean(book?.hasCover || book?.coverPath);
  const placeholder = coverPlaceholderSrc(book?.title);
  const src = hasCover ? `${API_BASE}/api/cover/${encodeURIComponent(id)}` : placeholder;
  return `<img src="${safeAttr(src)}" alt="${safeAttr(alt)}" class="${className}" loading="lazy" onerror="this.onerror=null;this.src='${placeholder}'" />`;
}
