'use strict';

const os = require('node:os');

// Use only independently configured/local names. Never resolve the supplied
// Host, and never trust X-Forwarded-Host to decide whether it is allowed.
function hostnameFromAuthority(value) {
  if (typeof value !== 'string' || !value || /[\s/@\\?#%,]/.test(value)) return '';
  try {
    const url = new URL(`http://${value}`);
    if (url.username || url.password || url.pathname !== '/' || !url.hostname) return '';
    return url.hostname.toLowerCase().replace(/\.$/, '');
  } catch { return ''; }
}

function createHostGuard({
  allowedHosts = process.env.XANDRIO_ALLOWED_HOSTS || '',
  canonicalOrigin = '',
  bindHost = process.env.HOST || '',
  hostname = os.hostname(),
  interfaces = os.networkInterfaces()
} = {}) {
  const allowed = new Set(['localhost', '127.0.0.1', '[::1]']);
  const add = value => {
    const host = hostnameFromAuthority(value);
    if (host) allowed.add(host);
    return host;
  };
  add(hostname);
  if (hostname && !hostname.includes('.')) add(`${hostname}.local`);
  if (bindHost && !['0.0.0.0', '::', '[::]'].includes(bindHost)) {
    add(bindHost.includes(':') && !bindHost.startsWith('[') ? `[${bindHost}]` : bindHost);
  }
  for (const records of Object.values(interfaces)) for (const record of records || []) {
    const address = record.address?.split('%')[0];
    if (address) add(address.includes(':') ? `[${address}]` : address);
  }
  if (canonicalOrigin) add(new URL(canonicalOrigin).host);
  for (const value of String(allowedHosts).split(',').map(value => value.trim()).filter(Boolean)) {
    if (!add(value) || value.includes('*')) throw new Error('XANDRIO_ALLOWED_HOSTS must contain exact hostnames or IP addresses.');
  }
  return function hostGuard(req, res, next) {
    const host = hostnameFromAuthority(req.headers?.host);
    if (!host || !allowed.has(host)) {
      return res.status(403).json({ error: 'Request host is not allowed', code: 'HOST_BLOCKED' });
    }
    next();
  };
}

module.exports = { createHostGuard };
