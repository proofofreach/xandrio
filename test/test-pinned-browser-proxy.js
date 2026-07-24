const assert = require('assert');
const net = require('net');
const { createPinnedBrowserProxy, parseConnectAuthority } = require('../lib/pinned-browser-proxy');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}: ${error.message}`);
  }
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function connect(port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let data = '';
    socket.once('error', reject);
    socket.on('data', chunk => {
      data += chunk;
      if (data.includes('\r\n\r\n')) resolve({ socket, response: data });
    });
    socket.once('connect', () => socket.write(request));
  });
}

async function main() {
  await test('CONNECT pins the upstream socket to the DNS-vetted address', async () => {
    let received;
    const upstream = net.createServer(socket => socket.once('data', data => { received = data.toString(); }));
    await listen(upstream);
    const upstreamPort = upstream.address().port;
    let connectOptions;
    const proxy = await createPinnedBrowserProxy({
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      connectImpl: options => {
        connectOptions = options;
        return net.connect({ host: '127.0.0.1', port: upstreamPort });
      }
    });
    try {
      const port = Number(new URL(proxy.url).port);
      const client = await connect(port, 'CONNECT allowed.example:443 HTTP/1.1\r\nHost: allowed.example:443\r\n\r\n');
      assert.match(client.response, /^HTTP\/1\.1 200 /);
      assert.deepStrictEqual(connectOptions, { host: '93.184.216.34', port: 443, family: 4 });
      client.socket.write('opaque TLS bytes');
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.strictEqual(received, 'opaque TLS bytes');
      client.socket.destroy();
    } finally {
      await proxy.close();
      await close(upstream);
    }
  });

  await test('private, malformed, and non-HTTPS CONNECT targets are rejected before connecting', async () => {
    let connections = 0;
    const proxy = await createPinnedBrowserProxy({
      lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }],
      connectImpl: () => { connections++; throw new Error('must not connect'); }
    });
    try {
      const port = Number(new URL(proxy.url).port);
      for (const authority of ['private.example:443', 'private.example:80', 'bad authority']) {
        const client = await connect(port, `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
        assert.match(client.response, /^HTTP\/1\.1 (?:400|403) /);
        client.socket.destroy();
      }
      const directHttp = await connect(port, 'GET http://allowed.example/ HTTP/1.1\r\nHost: allowed.example\r\n\r\n');
      assert.match(directHttp.response, /^HTTP\/1\.1 405 /);
      directHttp.socket.destroy();
      assert.strictEqual(connections, 0);
    } finally {
      await proxy.close();
    }
  });

  await test('only loopback proxy URLs and valid port-443 authorities are exposed', () => {
    assert.deepStrictEqual(parseConnectAuthority('example.com:443'), { hostname: 'example.com', port: 443 });
    assert.deepStrictEqual(parseConnectAuthority('[2001:4860:4860::8888]:443'), { hostname: '2001:4860:4860::8888', port: 443 });
    for (const authority of ['example.com:80', 'user@example.com:443', 'example.com:443/path']) {
      assert.throws(() => parseConnectAuthority(authority));
    }
  });

  console.log(`\nPinned browser proxy tests: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
