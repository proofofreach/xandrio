const assert = require('assert');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'integrations', 'calibre-plugin');
const archive = path.join(root, 'public', 'downloads', 'Xandrio-Calibre.zip');
const required = [
  '__init__.py',
  'action.py',
  'config.py',
  'network.py',
  'README.md',
  'plugin-import-name-xandrio.txt',
  'LICENSE'
];

execFileSync(process.execPath, [path.join(root, 'scripts', 'build-calibre-plugin.mjs')], { cwd: root });
assert(fs.statSync(archive).size > 1_000);
const firstHash = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
execFileSync(process.execPath, [path.join(root, 'scripts', 'build-calibre-plugin.mjs')], { cwd: root });
assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'), firstHash);

const entries = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).trim().split('\n');
assert.deepStrictEqual(entries.sort(), required.sort());
assert.strictEqual(
  execFileSync('unzip', ['-p', archive, 'plugin-import-name-xandrio.txt']).length,
  0
);

for (const name of required.filter(name => name.endsWith('.py'))) {
  const file = path.join(source, name);
  execFileSync('python3', ['-c', 'import pathlib,sys; p=pathlib.Path(sys.argv[1]); compile(p.read_text(), str(p), "exec")', file]);
}

const initializer = fs.readFileSync(path.join(source, '__init__.py'), 'utf8');
const action = fs.readFileSync(path.join(source, 'action.py'), 'utf8');
const network = fs.readFileSync(path.join(source, 'network.py'), 'utf8');
assert(initializer.includes("actual_plugin = 'calibre_plugins.xandrio.action:XandrioAction'"));
assert(initializer.includes('minimum_calibre_version = (7, 0, 0)'));
assert(action.includes('Send selected books'));
assert(action.includes('Send entire library'));
assert(action.includes("db.cover(book_id)"));
assert(action.includes("'/api/integrations/calibre/inventory'"));
assert(network.includes("'Authorization': 'Bearer ' + token"));
assert(network.includes("_write_file_header(payload, boundary, 'cover'"));
assert(network.includes('SpooledTemporaryFile'));
assert(execFileSync('unzip', ['-p', archive, 'LICENSE'], { encoding: 'utf8' }).startsWith('MIT License'));

console.log('18 passed, 0 failed');
