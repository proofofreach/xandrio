#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createLaunchAgentPlist } = require('../lib/local-service-runtime');

const LABEL = 'com.xandrio.server';
const root = path.resolve(__dirname, '..');
const domain = `gui/${process.getuid()}`;
const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);

function launchctl(args, { tolerateFailure = false } = {}) {
  try {
    return execFileSync('launchctl', args, { encoding: 'utf8', stdio: tolerateFailure ? 'pipe' : 'inherit' });
  } catch (error) {
    if (tolerateFailure) return '';
    throw error;
  }
}

function install() {
  if (process.platform !== 'darwin') throw new Error('The local launchd service is supported only on macOS');
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  const content = createLaunchAgentPlist({ label: LABEL, nodePath: process.execPath, root });
  const temporary = `${plistPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content, { mode: 0o644 });
  fs.renameSync(temporary, plistPath);
  launchctl(['bootout', domain, plistPath], { tolerateFailure: true });
  launchctl(['bootstrap', domain, plistPath]);
  launchctl(['kickstart', '-k', `${domain}/${LABEL}`]);
  console.log(`Installed ${LABEL} from ${root}`);
}

function restart() {
  launchctl(['kickstart', '-k', `${domain}/${LABEL}`]);
}

function status() {
  launchctl(['print', `${domain}/${LABEL}`]);
}

const command = process.argv[2] || 'status';
if (command === 'install') install();
else if (command === 'restart') restart();
else if (command === 'status') status();
else throw new Error(`Unknown local-service command: ${command}`);
