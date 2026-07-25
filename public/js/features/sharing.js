import { showToast } from '../ui/toast.js';

export function bookShareURL(bookId, locationLike = window.location) {
  const url = new URL(locationLike.href);
  url.search = '';
  url.hash = `#/player/${encodeURIComponent(bookId)}`;
  return url.toString();
}

function sharePayload(book, locationLike) {
  const title = book?.title || 'Untitled';
  const author = book?.author ? ` by ${book.author}` : '';
  return {
    title,
    text: `${title}${author}`,
    url: bookShareURL(book?.id, locationLike)
  };
}

async function copyShareURL(url, navigatorLike, documentLike) {
  if (navigatorLike?.clipboard?.writeText) {
    try {
      await navigatorLike.clipboard.writeText(url);
      return;
    } catch {}
  }

  const input = documentLike.createElement('textarea');
  input.value = url;
  input.setAttribute('readonly', '');
  input.style.position = 'fixed';
  input.style.opacity = '0';
  documentLike.body.appendChild(input);
  input.select();
  const copied = documentLike.execCommand?.('copy');
  input.remove();
  if (!copied) throw new Error('Clipboard is unavailable');
}

export async function shareBook(book, options = {}) {
  if (!book?.id) return 'unavailable';
  const navigatorLike = options.navigatorLike || navigator;
  const documentLike = options.documentLike || document;
  const locationLike = options.locationLike || window.location;
  const notify = options.notify || showToast;
  const payload = sharePayload(book, locationLike);

  if (typeof navigatorLike?.share === 'function') {
    try {
      await navigatorLike.share(payload);
      return 'shared';
    } catch (error) {
      if (error?.name === 'AbortError') return 'cancelled';
    }
  }

  try {
    await copyShareURL(payload.url, navigatorLike, documentLike);
    notify('Book link copied');
    return 'copied';
  } catch {
    notify('Could not share this book', 'error');
    return 'failed';
  }
}
