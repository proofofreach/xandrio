/**
 * Server entry point for the shared chapter playability rule. The browser
 * imports the same ES module, so client chapter selection and server playback
 * routes use one definition. Node 24 loads synchronous ES modules through
 * require().
 */
const {
  isPlayableChapter,
  findPlayableChapterIndex,
  resolvePlayableChapterIndex
} = require('../public/js/util/chapter-playability.mjs');

const CHAPTER_UNSPEAKABLE = 'CHAPTER_UNSPEAKABLE';

function isUnspeakableChapterError(error) {
  return error?.code === CHAPTER_UNSPEAKABLE;
}

function chapterUnspeakableError(message = 'Chapter has no speakable text for TTS') {
  return Object.assign(new Error(message), { code: CHAPTER_UNSPEAKABLE });
}

module.exports = {
  CHAPTER_UNSPEAKABLE,
  isPlayableChapter,
  findPlayableChapterIndex,
  resolvePlayableChapterIndex,
  isUnspeakableChapterError,
  chapterUnspeakableError
};
