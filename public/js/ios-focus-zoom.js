// iOS Safari zooms the page when a form control gains focus, which pushes
// controls beside the focused input off-screen. A `maximum-scale=1` viewport
// stops that automatic zoom. It is applied only while a form control has
// focus so pinch-to-zoom stays available everywhere else — Safari ignores
// the directive for pinch zoom, but the installed Home Screen app may not,
// and other browsers honour it literally, so only iOS gets it at all.
(function preventIosFocusZoom() {
  const ua = navigator.userAgent || '';
  // iPadOS reports itself as a Mac, so fall back to touch-point detection.
  const isIosDevice = /iPad|iPhone|iPod/.test(ua)
    || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  if (!isIosDevice) return;
  const viewport = document.querySelector('meta[name="viewport"]');
  if (!viewport) return;
  const base = viewport.content.replace(/,\s*maximum-scale=[^,]*/g, '');
  const zoomsOnFocus = (el) => el instanceof Element
    && (el.matches('input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]):not([type=range]), select, textarea')
      || el.isContentEditable);
  document.addEventListener('focusin', (event) => {
    if (zoomsOnFocus(event.target)) viewport.content = `${base}, maximum-scale=1`;
  });
  document.addEventListener('focusout', () => {
    viewport.content = base;
  });
})();
