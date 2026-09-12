'use strict';

const fs = require('fs/promises');
const path = require('path');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function writeBenchmarkReport(outputDir, html, report) {
  await fs.writeFile(path.join(outputDir, 'report.html'), html);
  await fs.writeFile(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2));
}

module.exports = { escapeHtml, writeBenchmarkReport };
