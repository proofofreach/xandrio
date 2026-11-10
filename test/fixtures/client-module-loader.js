// Loads a browser ES module from public/ with chosen imports replaced.
//
// `stubs` maps an import specifier, exactly as the module writes it, to the
// source text of a replacement module. A stub usually re-exports values from
// globalThis so the test can steer them. Every other relative import is
// resolved to its real file, so real helpers run unchanged.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

function dataUrl(source, tag = '') {
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}${tag ? `#${tag}` : ''}`;
}

// public/ has no package.json "type", so a .js file is inlined (recursively)
// as a data: module instead of being loaded from disk as CommonJS.
function rewrite(file, stubs, seen) {
  if (seen.has(file)) return seen.get(file);
  const dir = path.dirname(file);
  const source = fs.readFileSync(file, 'utf8').replace(/(from\s+|import\s*\(\s*)'([^']+)'/g, (match, prefix, spec) => {
    if (Object.hasOwn(stubs, spec)) return `${prefix}'${dataUrl(stubs[spec])}'`;
    if (!spec.startsWith('.')) return match;
    const target = path.join(dir, spec);
    if (target.endsWith('.mjs')) return `${prefix}'${pathToFileURL(target).href}'`;
    return `${prefix}'${rewrite(target, stubs, seen)}'`;
  });
  const url = dataUrl(source, `instance-${instance}-${path.relative(PUBLIC_DIR, file)}`);
  seen.set(file, url);
  return url;
}

let instance = 0;
// Stubs apply to every module in the graph, keyed by specifier text.
function loadClientModule(relativePath, stubs = {}) {
  instance += 1;
  return import(rewrite(path.join(PUBLIC_DIR, relativePath), stubs, new Map()));
}

// A Map-backed localStorage with the Web Storage key enumeration.
function memoryStorage(entries = []) {
  const map = new Map(entries);
  return {
    map,
    get length() { return map.size; },
    key: index => [...map.keys()][index] ?? null,
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: key => { map.delete(key); },
    clear: () => map.clear()
  };
}

module.exports = { loadClientModule, memoryStorage };
