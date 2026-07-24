const crypto = require('crypto');
const fs = require('fs');
const { WebSocket } = require('ws');
const { HttpsProxyAgent } = require('https-proxy-agent');
const {
  CHROMIUM_FULL_VERSION,
  TRUSTED_CLIENT_TOKEN,
  generateSecMsGecToken
} = require('node-edge-tts/dist/drm');

function abortError() {
  const error = new Error('TTS generation cancelled');
  error.name = 'AbortError';
  return error;
}

function escapeXml(value) {
  return String(value).replace(/[<>&"']/g, character => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;'
  })[character]);
}

async function connectEdgeWebSocket(tts, signal, WebSocketImpl = WebSocket) {
  if (signal?.aborted) throw abortError();
  const majorVersion = CHROMIUM_FULL_VERSION.split('.')[0];
  const socket = new WebSocketImpl(
    `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${generateSecMsGecToken()}&Sec-MS-GEC-Version=1-${CHROMIUM_FULL_VERSION}`,
    {
      host: 'speech.platform.bing.com',
      origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
      headers: {
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache',
        'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${majorVersion}.0.0.0 Safari/537.36 Edg/${majorVersion}.0.0.0`,
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      agent: tts.proxy ? new HttpsProxyAgent(tts.proxy) : undefined
    }
  );
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => fail(new Error('Edge TTS connection timed out')), tts.timeout || 10000);
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      socket.removeListener?.('open', onOpen);
      socket.removeListener?.('error', onError);
      socket.removeListener?.('close', onClose);
    };
    const fail = error => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.terminate?.();
      reject(error);
    };
    const onAbort = () => fail(abortError());
    const onError = error => fail(error);
    const onClose = () => fail(new Error('Edge TTS connection closed during handshake'));
    const onOpen = () => {
      if (settled) return;
      try {
        socket.send(`Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${JSON.stringify({
          context: { synthesis: { audio: { metadataoptions: {
            sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'true'
          }, outputFormat: tts.outputFormat } } }
        })}`);
        settled = true;
        cleanup();
        resolve(socket);
      } catch (error) {
        fail(error);
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.once('open', onOpen);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

/** Abort-aware equivalent of node-edge-tts's ttsPromise. */
async function synthesizeEdgeTts(tts, text, audioPath, signal, WebSocketImpl = WebSocket) {
  const socket = await connectEdgeWebSocket(tts, signal, WebSocketImpl);
  if (signal?.aborted) {
    socket.terminate?.();
    throw abortError();
  }

  await new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(audioPath);
    let settled = false;
    const timeout = setTimeout(() => fail(new Error('Edge TTS timed out')), tts.timeout || 10000);

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      socket.removeListener?.('error', onSocketError);
      socket.removeListener?.('close', onSocketClose);
    };
    const fail = error => {
      if (settled) return;
      settled = true;
      cleanup();
      stream.destroy();
      socket.terminate?.();
      reject(error);
    };
    const onAbort = () => fail(abortError());
    const onSocketError = error => fail(error);
    const onSocketClose = () => fail(new Error('Edge TTS connection closed before audio completed'));

    signal?.addEventListener('abort', onAbort, { once: true });
    socket.once?.('error', onSocketError);
    socket.once?.('close', onSocketClose);
    stream.once('error', fail);
    socket.on('message', (data, isBinary) => {
      if (settled) return;
      if (isBinary) {
        const separator = Buffer.from('Path:audio\r\n');
        const offset = data.indexOf(separator);
        if (offset >= 0) stream.write(data.subarray(offset + separator.length));
        return;
      }
      if (!data.toString().includes('Path:turn.end')) return;
      stream.end();
      stream.once('finish', () => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.close?.();
        resolve();
      });
    });

    try {
      const requestId = crypto.randomBytes(16).toString('hex');
      socket.send(`X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n` +
        `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${escapeXml(tts.lang)}"><voice name="${escapeXml(tts.voice)}"><prosody rate="${escapeXml(tts.rate)}" pitch="${escapeXml(tts.pitch)}" volume="${escapeXml(tts.volume)}">${escapeXml(text)}</prosody></voice></speak>`);
    } catch (error) {
      fail(error);
    }
  });
}

module.exports = { synthesizeEdgeTts, connectEdgeWebSocket };
