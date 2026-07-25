(function initOfflineRange(global) {
  function parseByteRange(rangeHeader, size) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader || ''));
    if (!match || (match[1] === '' && match[2] === '')) return null;

    let start;
    let end;
    if (match[1] === '') {
      const suffixLength = Number(match[2]);
      if (!Number.isInteger(suffixLength) || suffixLength <= 0) return null;
      start = Math.max(0, size - suffixLength);
      end = size - 1;
    } else {
      start = Number(match[1]);
      end = match[2] === '' ? size - 1 : Number(match[2]);
    }

    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      start >= size ||
      end < start
    ) {
      return null;
    }
    return { start, end: Math.min(end, size - 1) };
  }

  function rangeNotSatisfiable(size) {
    return new Response(null, {
      status: 416,
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes */${size}`
      }
    });
  }

  function rangedBody(body, start, end) {
    const reader = body.getReader();
    let sourceOffset = 0;
    let remaining = (end - start) + 1;

    return new ReadableStream({
      async pull(controller) {
        while (remaining > 0) {
          const { done, value } = await reader.read();
          if (done) {
            controller.error(new Error('Cached audio ended before the requested range'));
            return;
          }
          const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
          const chunkStart = sourceOffset;
          const chunkEnd = chunkStart + chunk.byteLength;
          sourceOffset = chunkEnd;
          if (chunkEnd <= start) continue;

          const from = Math.max(0, start - chunkStart);
          const length = Math.min(chunk.byteLength - from, remaining);
          if (length > 0) {
            controller.enqueue(chunk.subarray(from, from + length));
            remaining -= length;
          }
          if (remaining === 0) {
            await reader.cancel();
            controller.close();
          }
          return;
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      }
    });
  }

  async function createRangeResponse(cached, rangeHeader) {
    const size = Number(cached?.headers?.get('Content-Length'));
    if (!Number.isInteger(size) || size <= 0 || !cached?.body?.getReader) {
      return null;
    }
    const range = parseByteRange(rangeHeader, size);
    if (!range) return rangeNotSatisfiable(size);

    const headers = new Headers();
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Content-Length', String((range.end - range.start) + 1));
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    headers.set('Content-Type', cached.headers.get('Content-Type') || 'audio/mpeg');
    for (const name of ['ETag', 'Last-Modified', 'X-Xandrio-Content-SHA256']) {
      const value = cached.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(rangedBody(cached.body, range.start, range.end), {
      status: 206,
      statusText: 'Partial Content',
      headers
    });
  }

  global.XandrioOfflineRange = { createRangeResponse, parseByteRange };
})(globalThis);
