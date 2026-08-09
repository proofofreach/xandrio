const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
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

class NarrationArtifactCache {
  constructor(cacheDir, options = {}) {
    if (!cacheDir) throw new TypeError('cacheDir is required');
    this.cacheDir = path.resolve(cacheDir);
    this.fs = options.fs || fsp;
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

  async _writeMarker(request, size) {
    const markerPath = this._markerPath(request.outputPath);
    const temporaryPath = `${markerPath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    await this.fs.writeFile(temporaryPath, JSON.stringify({
      version: 1,
      fingerprint: request.fingerprint,
      bytes: size
    }));
    await this.fs.rename(temporaryPath, markerPath).catch(async error => {
      await this.fs.unlink(temporaryPath).catch(() => {});
      throw error;
    });
  }

  async resolve(request) {
    const sourcePath = this._path(request);
    const source = await validFile(sourcePath, this.fs);
    if (!source) {
      this.stats.misses++;
      return false;
    }
    if (await validFile(request.outputPath, this.fs)) {
      await this._writeMarker(request, source.size);
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
        try {
          await this.fs.copyFile(sourcePath, request.outputPath, fs.constants.COPYFILE_EXCL);
        } catch (copyError) {
          if (copyError?.code !== 'EEXIST' || !(await validFile(request.outputPath, this.fs))) {
            throw copyError;
          }
        }
      } else {
        throw error;
      }
    }
    await this._writeMarker(request, source.size);
    this.stats.hits++;
    this.stats.bytesAvoided += source.size;
    return true;
  }

  async publish(request) {
    const source = await validFile(request.outputPath, this.fs);
    if (!source) return false;
    const targetPath = this._path(request);
    if (await validFile(targetPath, this.fs)) {
      await this._writeMarker(request, source.size);
      return true;
    }
    await this.fs.mkdir(path.dirname(targetPath), { recursive: true });
    try {
      await this.fs.link(request.outputPath, targetPath);
    } catch (error) {
      if (error?.code !== 'EEXIST' || !(await validFile(targetPath, this.fs))) {
        if (!COPY_FALLBACK_CODES.has(error?.code)) throw error;
        try {
          await this.fs.copyFile(request.outputPath, targetPath, fs.constants.COPYFILE_EXCL);
        } catch (copyError) {
          if (copyError?.code !== 'EEXIST' || !(await validFile(targetPath, this.fs))) throw copyError;
        }
      }
    }
    await this._writeMarker(request, source.size);
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
      this.fs.unlink(markerPath).catch(() => {})
    ]);
    return true;
  }

  snapshot() {
    return { ...this.stats };
  }
}

module.exports = { NarrationArtifactCache, validFile };
