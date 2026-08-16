const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const settings = fs.readFileSync(path.join(root, 'public/js/views/settings.js'), 'utf8');

assert(html.includes('id="calibre-integration-section"'));
assert(html.includes('/downloads/Xandrio-Calibre.zip'));
assert(html.includes('id="calibre-pair-code"'));
assert(settings.includes("apiSend('POST', '/api/integrations/calibre/pairing-code'"));
assert(settings.includes("apiGet('/api/integrations/calibre/connections')"));
assert(settings.includes('data-calibre-revoke'));
assert(settings.includes("showToast('Calibre connected')"));

console.log('7 passed, 0 failed');
