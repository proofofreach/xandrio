#!/usr/bin/env node
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
if (args[0] !== 'exec') {
  process.stderr.write('Loopy Codex router expects the first argument to be "exec".\n');
  process.exit(2);
}

const child = spawn('codex', [
  'exec',
  '--model', 'gpt-5.6-terra',
  '--sandbox', 'workspace-write',
  '--ephemeral',
  ...args.slice(1)
], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: process.env
});

child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.once('error', error => {
  process.stderr.write(`Failed to start Codex: ${error.message}\n`);
  process.exit(1);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => child.kill(signal));
}
child.once('exit', (code, signal) => {
  if (signal) return process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
