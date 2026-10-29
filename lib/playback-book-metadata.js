'use strict';

// Playback needs chapter identity and accurate text lengths, but not a second
// copy of every narration string in the browser. Keep a short preview for
// existing display fallbacks and load pronunciation context only on demand.
function compactPlaybackChapter(chapter) {
  const text = String(chapter?.text || '');
  return {
    ...chapter,
    text: text.slice(0, 256),
    textLength: text.trim().length,
    normalizedTextLength: text.normalize('NFKC').replace(/\s+/gu, ' ').trim().length,
    textTruncated: text.length > 256
  };
}

function chapterPronunciationContext(chapter, ratio = 0) {
  const text = String(chapter?.text || '').replace(/\s+/g, ' ').trim();
  const center = Math.floor(text.length * Math.max(0, Math.min(1, ratio)));
  const start = Math.max(0, center - 100);
  const end = Math.min(text.length, center + 140);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

module.exports = { compactPlaybackChapter, chapterPronunciationContext };
