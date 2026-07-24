#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const {
  getKokoroChunkSize,
  prepareKokoroText
} = require('../lib/kokoro-tuning');
const { buildMasteringArgs } = require('../lib/audio-quality');
const { parseEpub } = require('../lib/epub-parser');

const execFileAsync = promisify(execFile);
const KOKORO_URL = (process.env.KOKORO_TTS_URL || 'http://127.0.0.1:8766').replace(/\/+$/, '');
const DEFAULT_OUTPUT_DIR = path.join(os.tmpdir(), 'xandrio-kokoro-quality');
const DEFAULT_VOICES = ['af_heart', 'af_bella', 'am_adam', 'am_michael', 'bm_george', 'bm_lewis'];
const DEFAULT_PROFILES = ['quality', 'balanced', 'fast'];
const DEFAULT_OUTPUT_FORMATS = ['mp3', 'wav'];

function parseArgs(argv) {
  const args = {
    book: '',
    chapter: 0,
    text: '',
    outputDir: DEFAULT_OUTPUT_DIR,
    voices: DEFAULT_VOICES,
    profiles: DEFAULT_PROFILES,
    outputs: DEFAULT_OUTPUT_FORMATS,
    includeRaw: true
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--book') {
      args.book = next;
      i++;
    } else if (arg === '--chapter') {
      args.chapter = Number(next);
      i++;
    } else if (arg === '--text') {
      args.text = next;
      i++;
    } else if (arg === '--output-dir' || arg === '--output') {
      args.outputDir = next;
      i++;
    } else if (arg === '--voices') {
      args.voices = next.split(',').map(item => item.trim()).filter(Boolean);
      i++;
    } else if (arg === '--profiles') {
      args.profiles = next.split(',').map(item => item.trim()).filter(Boolean);
      i++;
    } else if (arg === '--outputs' || arg === '--formats') {
      args.outputs = normalizeOutputFormats(next.split(','));
      i++;
    } else if (arg === '--raw') {
      args.includeRaw = true;
    } else if (arg === '--no-raw') {
      args.includeRaw = false;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function normalizeOutputFormats(values) {
  const outputs = [...new Set(values.map(item => String(item || '').trim().toLowerCase()).filter(Boolean))];
  for (const output of outputs) {
    if (!['mp3', 'wav'].includes(output)) throw new Error(`Unsupported output format: ${output}`);
  }
  return outputs.length ? outputs : DEFAULT_OUTPUT_FORMATS;
}

function printHelp() {
  console.log(`Usage:
  node scripts/benchmark-kokoro-quality.js
  node scripts/benchmark-kokoro-quality.js --book <book-id> --chapter 0
  node scripts/benchmark-kokoro-quality.js --voices af_heart,am_michael --profiles quality,balanced,fast
  node scripts/benchmark-kokoro-quality.js --outputs mp3,wav
  node scripts/benchmark-kokoro-quality.js --no-raw

Requires the Kokoro server at ${KOKORO_URL}.
Writes report.html, report.json, raw Kokoro WAV, and mastered audio samples to --output-dir.
`);
}

async function loadText(args) {
  if (args.text) return { label: 'custom text', text: args.text };
  if (args.book) {
    const books = JSON.parse(await fs.readFile(path.join(process.cwd(), 'data/books.json'), 'utf8'));
    const book = books[args.book];
    if (!book) throw new Error(`Book not found: ${args.book}`);
    const chapters = await loadBookChapters(book.path);
    const chapter = chapters?.[args.chapter];
    if (!chapter) throw new Error(`Chapter ${args.chapter} not found in ${book.path}`);
    return {
      label: `${book.title || args.book} chapter ${args.chapter}`,
      text: String(chapter.text || '').slice(0, 3500)
    };
  }
  return {
    label: 'default audiobook sample',
    text: [
      'Chapter 1',
      '',
      'The morning sun cast golden light through the library windows, illuminating rows of leather-bound books.',
      'Within the proper context, this pattern creates and recreates itself over and over again.',
      'It creates itself whenever the light changes on the way through the entry, and whenever a room has a window place that is alive.'
    ].join('\n')
  };
}

async function loadBookChapters(bookPath) {
  if (/\.xbook\.json$/i.test(bookPath)) {
    const artifact = JSON.parse(await fs.readFile(bookPath, 'utf8'));
    return artifact.chapters || [];
  }
  if (/\.epub$/i.test(bookPath)) {
    return extractEpubChapters(bookPath);
  }
  throw new Error(`Unsupported benchmark book path: ${bookPath}`);
}

async function extractEpubChapters(epubPath) {
  const {
    stripHTML,
    shouldFilterChapter,
    normalizeAllCapsTitle
  } = require('../lib/chapter-utils');

  async function getChapterText(epub, id) {
    try {
      return stripHTML(await epub.getChapter(id)).trim();
    } catch {
      return '';
    }
  }

  const epub = await parseEpub(epubPath);
  const chapters = [];
  for (let i = 0; i < epub.flow.length; i++) {
    const item = epub.flow[i];
    const text = await getChapterText(epub, item.id);
    if (!text) continue;
    const tocTitle = epub.toc?.find(toc => toc.href && item.href && toc.href.split('#')[0].endsWith(item.href.split('#')[0]))?.title;
    const title = normalizeAllCapsTitle(tocTitle || item.title || `Chapter ${chapters.length + 1}`);
    chapters.push({
      index: chapters.length,
      title,
      text,
      type: shouldFilterChapter({ title, text }) ? 'frontmatter' : 'content'
    });
  }
  return chapters;
}

function splitForProfile(text, chunkSize) {
  const paragraphs = String(text || '').split(/\n\s*\n/).map(part => part.trim()).filter(Boolean);
  const chunks = [];
  let current = '';
  for (const paragraph of paragraphs) {
    const next = current ? `${current}\n\n${paragraph}` : paragraph;
    if (next.length <= chunkSize) {
      current = next;
      continue;
    }
    if (current) chunks.push(current);
    current = paragraph;
  }
  if (current) chunks.push(current);
  return chunks.flatMap(chunk => chunk.length <= chunkSize ? [chunk] : splitSentences(chunk, chunkSize));
}

function splitSentences(text, chunkSize) {
  const sentences = String(text || '').match(/[^.!?]*[.!?]+[\s]*/g) || [text];
  const chunks = [];
  let current = '';
  for (const sentence of sentences.map(s => s.trim()).filter(Boolean)) {
    const next = current ? `${current} ${sentence}` : sentence;
    if (next.length <= chunkSize) current = next;
    else {
      if (current) chunks.push(current);
      current = sentence;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function outputPath(outputDir, voice, profile, index, outputFormat) {
  const id = crypto.createHash('sha1').update(`${voice}:${profile}:${index}:${outputFormat}`).digest('hex').slice(0, 8);
  const ext = outputFormat === 'raw-wav' ? 'wav' : outputFormat;
  return path.join(outputDir, `${profile}-${voice}-${index}-${outputFormat}-${id}.${ext}`);
}

async function synthesizeKokoro(text, outputSpecs, voice, rawFile = null) {
  const started = performance.now();
  const response = await fetch(`${KOKORO_URL}/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice, language: voice.startsWith('bm_') || voice.startsWith('bf_') ? 'en-gb' : 'en', format: 'wav' })
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Kokoro failed ${response.status}: ${body || response.statusText}`);
  }
  const audio = Buffer.from(await response.arrayBuffer());
  const synthElapsedMs = performance.now() - started;
  const wavFile = rawFile || `${outputSpecs[0].file}.source.wav`;
  const results = [];
  try {
    await fs.writeFile(wavFile, audio);
    if (rawFile) {
      const probe = await probeAudio(rawFile);
      const { size } = await fs.stat(rawFile);
      results.push({
        outputFormat: 'raw-wav',
        processing: 'raw server response',
        file: rawFile,
        synthElapsedMs,
        encodeElapsedMs: 0,
        elapsedMs: synthElapsedMs,
        duration: probe.duration,
        bytes: size,
        rtf: synthElapsedMs / 1000 / probe.duration,
        codec: probe.codec,
        sampleRate: probe.sampleRate,
        channels: probe.channels,
        bitRate: probe.bitRate
      });
    }
    for (const spec of outputSpecs) {
      const encodeStarted = performance.now();
      await execFileAsync('ffmpeg', buildMasteringArgs({
        inputFormat: 'wav',
        inputPath: wavFile,
        outputPath: spec.file,
        outputFormat: spec.outputFormat
      }));
      const encodeElapsedMs = performance.now() - encodeStarted;
      const probe = await probeAudio(spec.file);
      const { size } = await fs.stat(spec.file);
      results.push({
        outputFormat: spec.outputFormat,
        processing: 'xandrio mastered',
        file: spec.file,
        synthElapsedMs,
        encodeElapsedMs,
        elapsedMs: synthElapsedMs + encodeElapsedMs,
        duration: probe.duration,
        bytes: size,
        rtf: (synthElapsedMs + encodeElapsedMs) / 1000 / probe.duration,
        codec: probe.codec,
        sampleRate: probe.sampleRate,
        channels: probe.channels,
        bitRate: probe.bitRate
      });
    }
  } finally {
    if (!rawFile) await fs.unlink(wavFile).catch(() => {});
  }
  return results;
}

async function probeAudio(filePath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'stream=codec_name,sample_rate,channels,bit_rate:format=duration,bit_rate',
    '-of', 'json',
    filePath
  ]);
  const data = JSON.parse(stdout);
  const stream = (data.streams || [])[0] || {};
  return {
    duration: Number(data.format?.duration || 0),
    codec: stream.codec_name || 'unknown',
    sampleRate: Number(stream.sample_rate || 0),
    channels: Number(stream.channels || 0),
    bitRate: Number(stream.bit_rate || data.format?.bit_rate || 0)
  };
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value)) return 'n/a';
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function displayOutputFormat(format) {
  return String(format || '').toLowerCase() === 'raw-wav' ? 'RAW WAV' : String(format || '').toUpperCase();
}

async function writeReport(outputDir, report) {
  const grouped = new Map();
  for (const result of report.results) {
    const key = `${result.voice} / ${result.profile}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(result);
  }
  const comparisons = [...grouped.entries()].map(([label, results]) => `
    <section class="comparison">
      <h2>${escapeHtml(label)}</h2>
      <div class="meta">${results[0].chars} chars · chunk size ${results[0].chunkSize} · ${results[0].chunks} planned chunk(s)</div>
      <div class="cards">
        ${results.map(result => {
          const basename = path.basename(result.file);
          return `
          <article>
            <h3>${escapeHtml(displayOutputFormat(result.outputFormat))}</h3>
            <audio controls preload="none" src="${escapeHtml(basename)}"></audio>
            <dl>
              <dt>Processing</dt><dd>${escapeHtml(result.processing || 'xandrio mastered')}</dd>
              <dt>Codec</dt><dd>${escapeHtml(result.codec)}</dd>
              <dt>Sample rate</dt><dd>${result.sampleRate || 'n/a'} Hz</dd>
              <dt>Channels</dt><dd>${result.channels || 'n/a'}</dd>
              <dt>Bitrate</dt><dd>${result.bitRate ? `${Math.round(result.bitRate / 1000)} kbps` : 'PCM'}</dd>
              <dt>Size</dt><dd>${formatBytes(result.bytes)}</dd>
              <dt>Audio length</dt><dd>${result.duration.toFixed(2)}s</dd>
              <dt>Shared synth time</dt><dd>${Math.round(result.synthElapsedMs)}ms</dd>
              <dt>Encode time</dt><dd>${Math.round(result.encodeElapsedMs)}ms</dd>
              <dt>Total RTF</dt><dd>${result.rtf.toFixed(3)}</dd>
            </dl>
            <a href="${escapeHtml(basename)}">${escapeHtml(basename)}</a>
          </article>`;
        }).join('')}
      </div>
    </section>
  `).join('');
  const html = `<!doctype html>
<meta charset="utf-8">
<title>Kokoro Quality Side-by-Side</title>
<style>
body{font:14px -apple-system,BlinkMacSystemFont,sans-serif;max-width:1180px;margin:32px auto;background:#111;color:#eee;line-height:1.45}
h1{font-size:28px;margin:0 0 8px}h2{font-size:18px;margin:0 0 4px}h3{font-size:14px;margin:0 0 10px;color:#d4af37}
.intro{color:#bbb;margin:0 0 24px}.comparison{border-top:1px solid #333;padding:22px 0}.meta{color:#aaa;margin-bottom:12px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px}
article{border:1px solid #333;border-radius:8px;padding:14px;background:#181818}
audio{width:100%;margin-bottom:12px}dl{display:grid;grid-template-columns:120px 1fr;gap:5px 10px;margin:0 0 12px}
dt{color:#999}dd{margin:0}a{color:#d4af37;overflow-wrap:anywhere}pre{background:#1d1d1d;padding:12px;border-radius:6px;overflow:auto}
</style>
<h1>Kokoro Quality Side-by-Side</h1>
<p class="intro">${escapeHtml(report.source.label)}. Text chars: ${report.source.chars}. RAW WAV is the exact Kokoro server response; WAV and MP3 are Xandrio-mastered outputs.</p>
${comparisons}
<h2>JSON</h2>
<pre>${escapeHtml(JSON.stringify(report, null, 2))}</pre>`;
  await fs.writeFile(path.join(outputDir, 'report.html'), html);
  await fs.writeFile(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2));
}

async function main() {
  const args = parseArgs(process.argv);
  const outputDir = path.resolve(args.outputDir);
  await fs.mkdir(outputDir, { recursive: true });
  if (!fsSync.existsSync(outputDir)) throw new Error(`Output dir not found: ${outputDir}`);

  const source = await loadText(args);
  const results = [];
  for (const voice of args.voices) {
    for (const profile of args.profiles) {
      const prepared = prepareKokoroText(source.text);
      const chunkSize = getKokoroChunkSize(`kokoro:${voice}`, profile);
      const chunks = splitForProfile(prepared.text, chunkSize);
      const sampleText = chunks[0] || prepared.text;
      const outputSpecs = args.outputs.map(outputFormat => ({
        outputFormat,
        file: outputPath(outputDir, voice, profile, 0, outputFormat)
      }));
      const rawFile = args.includeRaw ? outputPath(outputDir, voice, profile, 0, 'raw-wav') : null;
      const metrics = await synthesizeKokoro(sampleText, outputSpecs, voice, rawFile);
      for (const metric of metrics) {
        const result = {
          voice,
          profile,
          chunkSize,
          chunks: chunks.length,
          chars: sampleText.length,
          diagnostics: prepared.diagnostics,
          ...metric
        };
        results.push(result);
        console.log(`${voice} ${profile} ${displayOutputFormat(metric.outputFormat)}: ${Math.round(metric.elapsedMs)}ms, ${metric.duration.toFixed(2)}s, RTF ${metric.rtf.toFixed(3)}, ${formatBytes(metric.bytes)}`);
      }
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    kokoroUrl: KOKORO_URL,
    outputs: args.outputs,
    includeRaw: args.includeRaw,
    source: { label: source.label, chars: source.text.length },
    results
  };
  await writeReport(outputDir, report);
  console.log(`Report: ${path.join(outputDir, 'report.html')}`);
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
