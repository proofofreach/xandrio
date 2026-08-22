#!/usr/bin/env node

import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const promptIndex = args.indexOf('-p');
const prompt = promptIndex >= 0 ? String(args[promptIndex + 1] || '') : '';
const builder = prompt.startsWith('[ROLE:BUILDER]');
const model = builder ? 'sonnet' : 'opus';
const claudeBin = process.env.XANDRIO_CLAUDE_BIN || 'claude';

if (!prompt) {
  process.stderr.write('Loopy Claude router requires the Claude Code -p prompt argument.\n');
  process.exit(2);
}

const child = spawn(claudeBin, [...args, '--model', model], {
  // Loopy supplies the complete prompt through `-p`; inheriting its open but
  // empty stdin makes recent Claude CLI builds wait and then fail with
  // "no stdin data received". An explicit closed stdin is equivalent to
  // invoking the CLI with </dev/null and keeps non-interactive runs stable.
  stdio: ['ignore', 'pipe', 'pipe'],
  env: process.env
});
const stdout = [];
child.stdout.on('data', chunk => stdout.push(chunk));
child.stderr.pipe(process.stderr);

child.once('error', error => {
  process.stderr.write(`Failed to start Claude Code: ${error.message}\n`);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => child.kill(signal));
}

child.once('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  const raw = Buffer.concat(stdout).toString('utf8');
  if (code === 0) {
    try {
      const envelope = JSON.parse(raw);
      if (typeof envelope.result === 'string') {
        // Claude sometimes prefaces an otherwise valid fenced JSON result
        // with one sentence. Extract the first fenced block anywhere in the
        // result instead of requiring the fence to occupy the whole string.
        const fenced = envelope.result.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
        const candidate = fenced ? fenced[1].trim() : envelope.result.trim();
        const structured = JSON.parse(candidate);
        if (structured && typeof structured === 'object') envelope.result = structured;
      }
      process.stdout.write(`${JSON.stringify(envelope)}\n`);
    } catch {
      process.stdout.write(raw);
    }
  } else {
    process.stdout.write(raw);
  }
  process.exit(code ?? 1);
});
