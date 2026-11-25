import {
  lstatSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { isPidAlive } from './procstat.mjs';
import { processStartTime } from './locks.mjs';

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

const LOCK_WAIT_MS = 5000;
const PROCESS_STARTED_AT = Math.round(Date.now() - process.uptime() * 1000);
const ownerPattern = /^(\d+)-[\da-f-]{36}$/;

function lockOwner(dir, startTimeOf) {
  try {
    if (!lstatSync(dir).isDirectory()) return { state: 'unknown' };
    const markers = readdirSync(dir);
    if (!markers.length) return { state: 'empty' };
    const marker = markers[0];
    const match = ownerPattern.exec(marker);
    if (markers.length !== 1 || !match) return { state: 'unknown' };
    const stat = lstatSync(join(dir, marker));
    if (!stat.isFile()) return { state: 'unknown' };
    const pid = Number(match[1]);
    const ageMs = Math.max(0, Date.now() - stat.mtimeMs);
    let state = 'held';
    if (!isPidAlive(pid)) state = 'dead';
    else if (ageMs >= LOCK_WAIT_MS) {
      // A process that started after the marker was created cannot own this lock.
      const started = startTimeOf(pid);
      const recorded = stat.size <= 32 ? Number(readFileSync(join(dir, marker), 'utf8')) : NaN;
      const ownerTime = recorded > 0 ? recorded : Math.max(stat.birthtimeMs, stat.mtimeMs);
      if (started != null && started > ownerTime + 2000) state = 'reused';
    }
    return { state, marker, pid, ageMs };
  } catch (error) {
    if (error.code === 'ENOENT') return { state: 'absent' };
    throw error;
  }
}

export function inspectRegistryLock(file) {
  return lockOwner(file + '.lock', processStartTime);
}

export function pruneRegistryStages(file) {
  const prefix = basename(file) + '.lock-';
  for (const entry of readdirSync(dirname(file), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const suffix = entry.name.slice(prefix.length);
    const stage = /^(?:(\d+)-)?[a-zA-Z0-9]{6}$/.exec(suffix);
    if (!stage) continue;
    const dir = join(dirname(file), entry.name);
    const owner = lockOwner(dir, processStartTime);
    if (owner.state === 'dead' || owner.state === 'reused') release(dir, owner.marker);
    else if (owner.state === 'empty' && stage[1] && !isPidAlive(Number(stage[1]))) release(dir);
  }
}

/** Publish a populated lock directory in one rename so even a crash leaves an identifiable owner. */
function* registryLockAttempts(file, action) {
  const lock = file + '.lock';
  const stage = mkdtempSync(lock + '-' + process.pid + '-');
  const marker = process.pid + '-' + randomUUID();
  let acquired = false;
  try {
    writeFileSync(join(stage, marker), String(PROCESS_STARTED_AT));
    const deadline = Date.now() + LOCK_WAIT_MS;
    const starts = new Map();
    const startTimeOf = (pid) => {
      if (!starts.has(pid)) starts.set(pid, processStartTime(pid));
      return starts.get(pid);
    };
    let finalRetry = false;
    while (!acquired) {
      try {
        renameSync(stage, lock);
        acquired = true;
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
        const owner = lockOwner(lock, startTimeOf);
        if (owner.state === 'empty' || owner.state === 'dead' || owner.state === 'reused') {
          release(lock, owner.marker);
          if (Date.now() >= deadline && !finalRetry) { finalRetry = true; continue; }
        }
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
