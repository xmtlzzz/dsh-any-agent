import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const sleepWord = new Int32Array(new SharedArrayBuffer(4));

/** @param {string} file @param {string | Uint8Array} content @param {{ mode?: number }} [options] */
export function writeFileAtomic(file, content, { mode } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + '.tmp.' + process.pid + '.' + randomUUID();
  const fd = openSync(tmp, 'wx', mode);
  try {
    try {
      writeFileSync(fd, content);
    } finally {
      closeSync(fd);
    }
    // Windows readers and indexers can briefly prevent replacement even when
    // this is the only writer. Keep the original in place through every retry.
    const deadline = Date.now() + 500;
    for (;;) {
      try {
        renameSync(tmp, file);
        break;
      } catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) ||
            Date.now() >= deadline) throw error;
        Atomics.wait(sleepWord, 0, 0, 10);
      }
    }
  } finally {
    rmSync(tmp, { force: true });
  }
}

export function writeJsonAtomic(file, value, options = {}) {
  writeFileAtomic(file, JSON.stringify(value, null, 2), options);
}
