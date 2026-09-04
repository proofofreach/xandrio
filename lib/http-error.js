'use strict';

// Unified 500 response (moved here from server.js so route modules that do
// not receive sendServerError via dependency injection can share the exact
// same semantics): log the full error server-side, return a generic public
// message with no raw err.message so internal details are not leaked.
function sendServerError(res, err, publicMessage = 'Something went wrong') {
  // A response whose socket is already gone means the client disconnected.
  // That is normal client behaviour, not a server fault: logging it at error
  // level buries real failures, and writing to the dead socket only produces
  // a second, more confusing error. Check this before logging and writing.
  if (res.destroyed || res.writableEnded) return;
  console.error(`${publicMessage}:`, err);
  // Routes that stream (audio, covers) may fail after the response has begun.
  // Writing a JSON body then would throw ERR_HTTP_HEADERS_SENT on top of the
  // original error; all that is left is cutting the connection.
  if (res.headersSent) {
    res.destroy?.();
    return;
  }
  res.status(500).json({ error: publicMessage });
}

function sendError(res, statusCode, message, code, extra) {
  const body = { error: message };
  if (code) body.code = code;
  if (extra && typeof extra === 'object') Object.assign(body, extra);
  return res.status(statusCode).json(body);
}

function internalError(res, message = 'Internal error', code) {
  return sendError(res, 500, message, code);
}

function badRequest(res, message = 'Invalid request', code) {
  return sendError(res, 400, message, code);
}

function notFound(res, message = 'Not found', code) {
  return sendError(res, 404, message, code);
}

function unauthorized(res, message = 'Unauthorized', code) {
  return sendError(res, 401, message, code);
}

function forbidden(res, message = 'Forbidden', code) {
  return sendError(res, 403, message, code);
}

function conflict(res, message = 'Conflict', code) {
  return sendError(res, 409, message, code);
}

function invalidBookId(res, message = 'Invalid book identifier') {
  return badRequest(res, message);
}

function unavailable(res, message = 'Unavailable', code) {
  return sendError(res, 503, message, code);
}

// Storage-layer failure with a call-site-specific log prefix: same
// dead-response guards as sendServerError (a JSON write to a dead or
// already-sent response throws a second error on top of the original).
// The log stays above the guard: a storage fault is operationally important
// even after the client disconnected.
// Replaces the per-file sendStorageError helpers copy-pasted across routes.
function storageError(res, err, message, prefix = 'Storage failed:') {
  console.error(prefix, err);
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    res.destroy?.();
    return;
  }
  res.status(500).json({ error: message });
}

module.exports = { sendError, sendServerError, internalError, badRequest, notFound, unauthorized, forbidden, conflict, invalidBookId, unavailable, storageError };
