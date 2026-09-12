const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const path = require('path');
const { pipeline } = require('stream/promises');
const { isSafeBookId } = require('./request-guards');

const COPY_FALLBACK_CODES = new Set(['EACCES', 'EPERM', 'EXDEV', 'ENOSYS', 'ENOTSUP']);

async function validFile(filePath, filesystem = fsp) {
  try {
    const stat = await filesystem.stat(filePath);
    return stat.isFile() && stat.size > 0 ? stat : null;
  } catch {
    return null;
  }
}

const VERIFIED_MARKER_VERSION = 2;
const SHA256_PATTERN = /^sha256-[a-f0-9]{64}$/;

function abortError() {
  return Object.assign(new Error('Narration artifact operation cancelled'), {
    name: 'AbortError',
    code: 'ABORT_ERR'
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

async function sha256File(filePath, {
  filesystem = fsp,
  createReadStream = fs.createReadStream,
  signal
} = {}) {
  throwIfAborted(signal);
  const stat = await validFile(filePath, filesystem);
  if (!stat) return null;
  const hash = crypto.createHash('sha256');
  const readStream = createReadStream(filePath);
  const abort = () => readStream.destroy?.(abortError());
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for await (const chunk of readStream) {
      throwIfAborted(signal);
      hash.update(chunk);
    }
  } finally {
    signal?.removeEventListener('abort', abort);
  }
  throwIfAborted(signal);
  return {
    bytes: stat.size,
    contentHash: `sha256-${hash.digest('hex')}`
  };
}

function verifiedMarker(marker, request, stat) {
  return Boolean(
    marker?.version === VERIFIED_MARKER_VERSION &&
    marker.provenance === 'verified' &&
    marker.fingerprint === request.fingerprint &&
    marker.bytes === stat.size &&
    SHA256_PATTERN.test(String(marker.contentHash || ''))
  );
}

class NarrationArtifactCache {
  constructor(cacheDir, options = {}) {
    if (!cacheDir) throw new TypeError('cacheDir is required');
    this.cacheDir = path.resolve(cacheDir);
    this.fs = options.fs || fsp;
    this.createReadStream = options.createReadStream || fs.createReadStream;
    this.createWriteStream = options.createWriteStream || fs.createWriteStream;
    this.stats = { hits: 0, misses: 0, published: 0, bytesAvoided: 0 };
  }

  _path({ bookId, chapterIndex, fingerprint, outputPath }) {
    if (!isSafeBookId(bookId)) throw new TypeError('Invalid artifact book id');
    if (!Number.isInteger(chapterIndex) || chapterIndex < 0) {
      throw new TypeError('Invalid artifact chapter index');
    }
    if (!/^[a-f0-9]{64}$/.test(String(fingerprint || ''))) {
      throw new TypeError('Invalid artifact fingerprint');
    }
    const extension = path.extname(String(outputPath || '')).toLowerCase();
    if (extension !== '.mp3' && extension !== '.wav') {
      throw new TypeError('Invalid artifact output format');
    }
    return path.join(
      this.cacheDir,
      `${bookId}_narration_artifacts_v1`,
      `ch${chapterIndex}`,
      `${fingerprint}${extension}`
    );
  }

  _markerPath(outputPath) {
    return `${outputPath}.narration-artifact.json`;
  }

  async _writeMarkerAt(markerPath, marker, signal) {
    throwIfAborted(signal);
    const temporaryPath = `${markerPath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      await this.fs.writeFile(temporaryPath, JSON.stringify(marker));
      throwIfAborted(signal);
      await this.fs.rename(temporaryPath, markerPath);
    } finally {
      await this.fs.unlink(temporaryPath).catch(() => {});
    }
  }

  async _readMarker(outputPath) {
    try {
      return JSON.parse(await this.fs.readFile(this._markerPath(outputPath), 'utf8'));
    } catch (error) {
      return error?.code === 'ENOENT' ? null : { version: 'invalid' };
    }
  }

  async _writeVerifiedMarker(request, outputPath, identity, signal) {
    await this._writeMarkerAt(this._markerPath(outputPath), {
      version: VERIFIED_MARKER_VERSION,
      fingerprint: request.fingerprint,
      bytes: identity.bytes,
      contentHash: identity.contentHash,
      provenance: 'verified'
    }, signal);
  }

  async inspect(request, outputPath = request.outputPath, { signal } = {}) {
    throwIfAborted(signal);
    const stat = await validFile(outputPath, this.fs);
    throwIfAborted(signal);
    if (!stat) return null;
    const marker = await this._readMarker(outputPath);
    const legacy = !marker || marker.version === 1;
    if (!legacy && !verifiedMarker(marker, request, stat)) {
      return {
        fingerprint: '',
        bytes: stat.size,
        contentHash: '',
        provenance: 'invalid'
      };
    }
    if (!verifiedMarker(marker, request, stat)) {
      return {
        fingerprint: '',
        bytes: stat.size,
        contentHash: '',
        provenance: 'legacy-unverified'
      };
    }
    const identity = await sha256File(outputPath, {
      filesystem: this.fs,
      createReadStream: this.createReadStream,
      signal
    });
    if (!identity || identity.contentHash !== marker.contentHash) {
      return {
        fingerprint: '',
        bytes: stat.size,
        contentHash: '',
        provenance: 'invalid'
      };
    }
    return {
      fingerprint: request.fingerprint,
      ...identity,
      provenance: 'verified'
    };
  }

  async resolve(request, { signal } = {}) {
    throwIfAborted(signal);
    const sourcePath = this._path(request);
    const source = await validFile(sourcePath, this.fs);
    if (!source) {
      this.stats.misses++;
      return false;
    }
    const sourceIdentity = await this.inspect(request, sourcePath, { signal });
    if (sourceIdentity?.provenance !== 'verified') {
      if (sourceIdentity?.provenance === 'invalid') {
        await this._discardOutput(sourcePath, { signal });
      }
      this.stats.misses++;
      return false;
    }
    const outputIdentity = await this.inspect(request, request.outputPath, { signal });
    if (outputIdentity?.provenance === 'invalid') {
      await this._discardOutput(request.outputPath, { signal });
    } else if (outputIdentity) {
      this.stats.hits++;
      this.stats.bytesAvoided += source.size;
      return true;
    }
    await this.fs.mkdir(path.dirname(request.outputPath), { recursive: true });
    try {
      await this.fs.link(sourcePath, request.outputPath);
    } catch (error) {
      if (error?.code === 'EEXIST' && await validFile(request.outputPath, this.fs)) {
        // A concurrent resolver won the race.
      } else if (COPY_FALLBACK_CODES.has(error?.code)) {
        const temporaryPath = `${request.outputPath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
        try {
          await pipeline(
            this.createReadStream(sourcePath),
            this.createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }),
            { signal }
          );
          throwIfAborted(signal);
          await this.fs.rename(temporaryPath, request.outputPath);
        } catch (copyError) {
          if (copyError?.code !== 'EEXIST' || !(await validFile(request.outputPath, this.fs))) {
            throw copyError;
          }
        } finally {
          await this.fs.unlink(temporaryPath).catch(() => {});
        }
      } else {
        throw error;
      }
    }
    await this._writeVerifiedMarker(request, request.outputPath, sourceIdentity, signal);
    throwIfAborted(signal);
    this.stats.hits++;
    this.stats.bytesAvoided += source.size;
    return true;
  }

  async publish(request, { verified = false, signal } = {}) {
    return verified
      ? this.publishVerified(request, null, { signal })
      : this.publishLegacy(request, { signal });
  }

  async publishLegacy(request, { signal } = {}) {
    throwIfAborted(signal);
    const source = await validFile(request.outputPath, this.fs);
    if (!source) return false;
    const existing = await this.inspect(request, request.outputPath, { signal });
    if (existing?.provenance === 'verified') {
      return this.publishVerified(request, existing, { signal });
    }
    if (existing?.provenance === 'invalid') return false;
    // Preserve unproved output in place. Do not create or rewrite a recipe
    // marker because only successful generation may mint that provenance.
    return true;
  }

  async _discardOutput(outputPath, { signal } = {}) {
    throwIfAborted(signal);
    await Promise.all([
      this.fs.unlink(outputPath).catch(() => {}),
      this.fs.unlink(this._markerPath(outputPath)).catch(() => {})
    ]);
  }

  async reuseExisting(request, { signal } = {}) {
    throwIfAborted(signal);
    const identity = await this.inspect(request, request.outputPath, { signal });
    if (!identity) return false;
    if (identity.provenance === 'invalid') {
      await this._discardOutput(request.outputPath, { signal });
      return false;
    }
    if (identity.provenance === 'verified') {
      await this.publishVerified(request, identity, { signal });
    }
    return true;
  }

  async publishVerified(request, knownIdentity = null, { signal } = {}) {
    throwIfAborted(signal);
    const source = await validFile(request.outputPath, this.fs);
    if (!source) return false;
    const identity = knownIdentity?.provenance === 'verified'
      ? knownIdentity
      : await sha256File(request.outputPath, {
          filesystem: this.fs,
          createReadStream: this.createReadStream,
          signal
        });
    if (!identity || identity.bytes !== source.size) return false;
    const targetPath = this._path(request);
    await this.fs.mkdir(path.dirname(targetPath), { recursive: true });
    const targetIdentity = await this.inspect(request, targetPath, { signal });
    if (
      targetIdentity?.provenance !== 'verified' ||
      targetIdentity.contentHash !== identity.contentHash
    ) {
      const temporaryPath = `${targetPath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
      try {
        await pipeline(
          this.createReadStream(request.outputPath),
          this.createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }),
          { signal }
        );
        throwIfAborted(signal);
        await this.fs.rename(temporaryPath, targetPath);
      } finally {
        await this.fs.unlink(temporaryPath).catch(() => {});
      }
    }
    await this._writeVerifiedMarker(request, request.outputPath, identity, signal);
    await this._writeVerifiedMarker(request, targetPath, identity, signal);
    throwIfAborted(signal);
    this.stats.published++;
    return true;
  }

  async invalidate({ bookId, chapterIndex, outputPath }) {
    const markerPath = this._markerPath(outputPath);
    let marker = null;
    try {
      marker = JSON.parse(await this.fs.readFile(markerPath, 'utf8'));
    } catch {}
    if (!/^[a-f0-9]{64}$/.test(String(marker?.fingerprint || ''))) {
      await this.fs.unlink(markerPath).catch(() => {});
      return false;
    }
    const artifactPath = this._path({
      bookId,
      chapterIndex,
      fingerprint: marker.fingerprint,
      outputPath
    });
    await Promise.all([
      this.fs.unlink(artifactPath).catch(() => {}),
      this.fs.unlink(this._markerPath(artifactPath)).catch(() => {}),
      this.fs.unlink(markerPath).catch(() => {})
    ]);
    return true;
  }

  snapshot() {
    return { ...this.stats };
  }
}

module.exports = {
  VERIFIED_MARKER_VERSION,
  NarrationArtifactCache,
  sha256File,
  validFile
};
