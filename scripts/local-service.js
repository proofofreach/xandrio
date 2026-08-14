#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawn } = require('child_process');
const { createRuntimeSupervisor } = require('../lib/local-service-runtime');

const root = path.resolve(__dirname, '..');
const serverEntry = path.join(root, 'server.js');

const supervisor = createRuntimeSupervisor({
  root,
  spawnChild({ revision }) {
    return spawn(process.execPath, ['--env-file-if-exists=.env', serverEntry], {
      cwd: root,
      env: {
        ...process.env,
        XANDRIO_RUNTIME_REVISION: revision,
        XANDRIO_SUPERVISED: '1'
      },
      stdio: 'inherit'
    });
  }
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  await supervisor.stop();
  process.exit(signal === 'SIGINT' ? 130 : 0);
}

process.title = 'xandrio-local-service';
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
supervisor.start();
