'use strict';

const crypto = require('crypto');
const fsPromises = require('fs/promises');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const { byteLimit, declaredLength } = require('./remote-fetch');

function temporaryDownloadPath(destinationPath) {
  const directory = path.dirname(destinationPath);
  const fileName = path.basename(destinationPath);
  const suffix = crypto.randomBytes(8).toString('hex');
  return path.join(directory, `.${fileName}.${process.pid}.${suffix}.part`);
}

// Publish an already-authorized remote response body without exposing a
// partial file at the destination. Callers retain ownership of response
// validation and the requestRemote().close() lifecycle.
async function streamResponseToFile(response, destinationPath, maxBytes) {
  const length = declaredLength(response);
  if (length !== null && length > maxBytes) {
    throw new Error('Remote response exceeds the allowed size');
  }
  await fsPromises.mkdir(path.dirname(destinationPath), { recursive: true });
  const temporaryPath = temporaryDownloadPath(destinationPath);
  // Acquire ownership before entering cleanup: an exclusive-open failure
  // must never remove a temporary file belonging to another writer.
  const handle = await fsPromises.open(temporaryPath, 'wx');
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      byteLimit(maxBytes),
      handle.createWriteStream()
    );
    await fsPromises.rename(temporaryPath, destinationPath);
    return destinationPath;
  } finally {
    try {
      await handle.close();
    } finally {
      await fsPromises.unlink(temporaryPath).catch(() => {});
    }
  }
}

module.exports = { streamResponseToFile };
