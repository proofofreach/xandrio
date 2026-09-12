#!/usr/bin/env node
// Operator recovery goes through the authenticated server so validation and
// publication share the book lifecycle lock with deletion and reimport.
async function main() {
  const args = process.argv.slice(2);
  const value = name => args[args.indexOf(name) + 1];
  if (!['--book', '--source-variant', '--voice'].every(name => args.includes(name)) ||
    !args.includes('--accept-unverified-source-association')) {
    throw new Error('Usage: recover-offline-package --book ID --voice VOICE --source-variant ORIGINAL_VARIANT --accept-unverified-source-association');
  }
  const token = process.env.XANDRIO_TOKEN;
  if (!token) throw new Error('XANDRIO_TOKEN is required for operator recovery');
  const origin = process.env.XANDRIO_RECOVERY_ORIGIN || 'http://127.0.0.1:8181';
  const url = new URL(`/api/admin/offline/preparation/${encodeURIComponent(value('--book'))}/recover`, origin);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    const response = await fetch(url, {
      method: 'POST', signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceVoice: value('--voice'), sourceVariantKey: value('--source-variant'),
        acceptUnverifiedSourceAssociation: true })
    });
    if (!response.ok) throw new Error(`Recovery request failed: HTTP ${response.status}`);
    let buffer = '';
    let result = null;
    const decoder = new TextDecoder();
    for await (const bytes of response.body) {
      buffer += decoder.decode(bytes, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line) continue;
        const event = JSON.parse(line);
        if (event.error) throw new Error(event.error);
        if (event.completed) console.log(`Validated ${event.completed}/${event.total} chapters`);
        if (event.result) result = event.result;
      }
    }
    if (!result) throw new Error('Recovery ended without a completion receipt');
    console.log(JSON.stringify(result));
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
