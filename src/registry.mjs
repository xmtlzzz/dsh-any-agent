import { L } from './lang.mjs';
import {
  lstatSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { isPidAlive } from './procstat.mjs';
import { processStartTime } from './locks.mjs';
import { isWinTransient, retryWinTransientSync } from './fs-atomic.mjs';

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
    if (marker) retryWinTransientSync(() => unlinkSync(join(dir, marker)), 250);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    retryWinTransientSync(() => rmdirSync(dir), 250);
  } catch (error) {
    // Once the marker is gone, the next writer can reclaim the empty directory.
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code) && !isWinTransient(error)) throw error;
  }
}

const LOCK_WAIT_MS = 5000;
const PROCESS_STARTED_AT = Math.round(Date.now() - process.uptime() * 1000);
const ownerPattern = /^(\d+)-[\da-f-]{36}$/;

function lockOwner(dir, startTimeOf) {
  try {
    return retryWinTransientSync(() => readLockOwner(dir, startTimeOf), 100);
  } catch (error) {
    if (error.code === 'ENOENT') return { state: 'absent' };
    throw error;
  }
}

function readLockOwner(dir, startTimeOf) {
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
    try {
      const owner = lockOwner(dir, processStartTime);
      if (owner.state === 'dead' || owner.state === 'reused') release(dir, owner.marker);
      else if (owner.state === 'empty' && stage[1] && !isPidAlive(Number(stage[1]))) release(dir);
    } catch (error) {
      if (error.code !== 'ENOENT' && !isWinTransient(error)) throw error;
    }
  }
}

/**
 * Publish a populated lock directory in one rename so even a crash leaves an identifiable owner.
 * @template T
 * @param {string} file
 * @param {()=>T} action
 * @returns {Generator<number,T>}
 */
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
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        try {
          const owner = lockOwner(lock, startTimeOf);
          if (owner.state === 'empty' || owner.state === 'dead' || owner.state === 'reused') {
            release(lock, owner.marker);
            if (Date.now() >= deadline && !finalRetry) { finalRetry = true; continue; }
          }
        } catch (ownerError) {
          if (!isWinTransient(ownerError)) throw ownerError;
        }
        if (Date.now() >= deadline) {
          throw new Error(L('无法获取注册表锁 ', 'Cannot acquire registry lock ') + lock + ': ' + error.message);
        }
        yield 10;
      }
    }
    return action();
  } finally {
    release(acquired ? lock : stage, marker);
  }
}

// The server can handle other requests while waiting for another writer.
export async function withRegistryLock(file, action) {
  for (const ms of registryLockAttempts(file, action)) await delay(ms);
}

/**
 * @template T
 * @param {string} file
 * @param {()=>T} action
 * @returns {T}
 */
export function withRegistryLockSync(file, action) {
  const attempts = registryLockAttempts(file, action);
  let step = attempts.next();
  while (step.done === false) {
    Atomics.wait(sleepWord, 0, 0, step.value);
    step = attempts.next();
  }
  return step.value;
}

export { writeJsonAtomic as writeRegistry } from './fs-atomic.mjs';
