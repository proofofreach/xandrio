#!/usr/bin/env node

/**
 * Benchmark Kindle extraction quality before spending TTS time.
 *
 * Usage:
 *   node scripts/benchmark-kindle-extraction.js --input cache/book.mobi
 *   node scripts/benchmark-kindle-extraction.js --input cache/book.azw3 --output /tmp/kindle-report.json
 */

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { extractKindleChapters } = require('../lib/kindle-extraction');

function parseArgs(argv) {
  const args = {
    input: '',
    output: '',
    format: ''
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--input' || arg === '-i') {
      args.input = next;
      i++;
    } else if (arg === '--output' || arg === '-o') {
      args.output = next;
      i++;
    } else if (arg === '--format') {
      args.format = next;
      i++;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.input) throw new Error('Missing --input');
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/benchmark-kindle-extraction.js --input <mobi-azw-azw3-prc> [--output report.json]

Scores Kindle extraction before TTS:
  - parser candidate availability
  - extracted chapters, TOC/spine counts, and text length
  - malformed/DRM/unsupported status
  - extraction warnings and first-section previews
`);
}

async function main() {
  const args = parseArgs(process.argv);
  const input = path.resolve(args.input);
  if (!fsSync.existsSync(input)) throw new Error(`Input not found: ${input}`);

  let chapters = [];
  let extraction = null;
  let error = null;
  try {
    chapters = await extractKindleChapters(input, {
      format: args.format || path.extname(input).slice(1),
      warn: false
    });
    extraction = chapters[0]?.kindleExtraction || null;
  } catch (err) {
    error = err.message;
    extraction = err.kindleExtraction || null;
  }

  const report = {
    input,
    generatedAt: new Date().toISOString(),
    ok: !error,
    error,
    extraction,
    preview: chapters.slice(0, 5).map(chapter => ({
      title: chapter.title,
      type: chapter.type,
      chars: String(chapter.text || '').length,
      start: String(chapter.text || '').slice(0, 180).replace(/\s+/g, ' ').trim()
    }))
  };

  const json = JSON.stringify(report, null, 2);
  if (args.output) {
    await fs.writeFile(path.resolve(args.output), json);
  }

  printSummary(report);
  if (args.output) console.log(`\nReport written to ${path.resolve(args.output)}`);
  if (error) process.exitCode = 1;
}

function printSummary(report) {
  console.log(`Kindle extraction benchmark: ${report.input}`);
  if (report.error) console.log(`error: ${report.error}`);
  if (!report.extraction) return;
  console.log(`selected: ${report.extraction.selected || 'none'}`);
  console.log(`status: ${report.extraction.status}`);
  console.log(`score: ${report.extraction.score}`);
  console.log(`chapters: ${report.extraction.chapterCount || 0}`);
  console.log(`chars: ${report.extraction.totalChars || 0}`);
  if (report.extraction.spineCount || report.extraction.tocCount) {
    console.log(`spine/toc: ${report.extraction.spineCount || 0}/${report.extraction.tocCount || 0}`);
  }
  if (report.extraction.formatDetected) console.log(`detected: ${report.extraction.formatDetected}`);
  if (report.extraction.warnings?.length) {
    console.log('warnings:');
    report.extraction.warnings.forEach(warning => console.log(`  - ${warning}`));
  }
  if (report.preview.length) {
    console.log('preview:');
    report.preview.forEach(item => console.log(`  - ${item.title} (${item.chars} chars): ${item.start}`));
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
