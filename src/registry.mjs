import {
  mkdtempSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { isPidAlive } from './procstat.mjs';

const sleepWord = new Int32Array(new SharedArrayBuffer(4));

/** Only a missing registry represents an empty installation. */
export function readRegistry(file) {
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!Array.isArray(doc?.conversations) || (doc.version != null && doc.version !== 1)) {
      throw new Error('Unsupported conversation registry format');
    }
    if (doc.conversations.some((entry) => typeof entry?.id !== 'string' || !entry.id ||
        typeof entry.cwd !== 'string' || !entry.cwd)) {
      throw new Error('Invalid conversation registry entry');
    }
    return doc;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Cannot read conversation registry ${file}: ${error.message}`, { cause: error });
  }
}

// Only remove a specific owner's marker and an empty directory. A second
// contender cleaning up a dead owner cannot remove a successor's marker.
function release(dir, marker) {
  try {
    if (marker) unlinkSync(join(dir, marker));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    rmdirSync(dir);
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
  }
}

function clearDeadOwner(dir) {
  let markers;
  try {
    markers = readdirSync(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (!markers.length) return release(dir);
  const marker = markers[0];
  const owner = /^(\d+)-[\da-f-]{36}$/.exec(marker);
  if (markers.length === 1 && owner && !isPidAlive(Number(owner[1]))) release(dir, marker);
}

/** Publish a populated lock directory in one rename so even a crash leaves an identifiable owner. */
function* registryLockAttempts(file, action) {
  const lock = file + '.lock';
  const stage = mkdtempSync(lock + '-');
  const marker = process.pid + '-' + randomUUID();
  let acquired = false;
  try {
    writeFileSync(join(stage, marker), '');
    const deadline = Date.now() + 5000;
    while (!acquired) {
      try {
        renameSync(stage, lock);
        acquired = true;
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
        clearDeadOwner(lock);
        if (Date.now() >= deadline) throw new Error(`Cannot acquire conversation registry lock ${lock}: ${error.message}`);
        yield 10;
      }
    }
    action();
  } finally {
    release(acquired ? lock : stage, marker);
  }
}

// The server can handle other requests while waiting for another writer.
export async function withRegistryLock(file, action) {
  for (const ms of registryLockAttempts(file, action)) await delay(ms);
}

// Maintenance commands expose a synchronous cleanup API.
export function withRegistryLockSync(file, action) {
  for (const ms of registryLockAttempts(file, action)) Atomics.wait(sleepWord, 0, 0, ms);
}

export function writeRegistry(file, doc) {
  const tmp = file + '.tmp.' + randomUUID();
  try {
    writeFileSync(tmp, JSON.stringify(doc, null, 2), { encoding: 'utf8', flag: 'wx' });
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
    try { unlinkSync(tmp); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
