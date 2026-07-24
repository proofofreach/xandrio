#!/usr/bin/env node
/**
 * Helper: extract chapters from a single EPUB and output JSON to stdout.
 * Usage: node test/extract-helper.js /path/to/book.epub
 *
 * Runs in a child process so a hung EPUB parse can't stall the test suite.
 */
const { extractChapters } = require('../lib/chapter-extraction');

const epubPath = process.argv[2];
if (!epubPath) {
  console.error('Usage: node extract-helper.js <epub-path>');
  process.exit(1);
}

extractChapters(epubPath)
  .then((chapters) => {
    console.log(JSON.stringify(chapters.map(ch => ({
      title: ch.title,
      type: ch.type,
      textLength: ch.text ? ch.text.length : 0,
      empty: ch.empty || false,
      estimatedDuration: ch.estimatedDuration
    }))));
  })
  .catch((err) => {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  });
