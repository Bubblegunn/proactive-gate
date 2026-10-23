// Marketing-message frequency cap: at most 2 marketing messages per customer
// per local calendar day (midnight to midnight in the customer's time zone),
// counted across all channels and all worker processes.
//
// Shared state lives only in files under STATE_DIR:
//   users/<sha256(userId)>.json   JSON array of send instants (ms since epoch)
//   locks/<sha256(userId)>.lock   mkdir-based lock directory (one per user)
// Each call takes the user's lock, reads the file, decides, and (if allowed)
// durably writes the new send before releasing the lock, so concurrent
// workers cannot both take the last slot.

import { createHash } from 'node:crypto';
import { mkdir, rmdir, rename, stat, readFile, open, rm } from 'node:fs/promises';
import path from 'node:path';

const DAILY_LIMIT = 2;
const CHANNELS = new Set(['sms', 'email', 'push']);
const LOCK_STALE_MS = 15_000; // the critical section takes milliseconds
const LOCK_TIMEOUT_MS = 60_000;
const KEEP_MS = 48 * 3600 * 1000; // a local day is at most ~25h, so older sends never count

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => createHash('sha256').update(s).digest('hex');

// Local calendar day ("YYYY-MM-DD") of an instant in a time zone.
const formatters = new Map();
function dayKey(ms, timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone, calendar: 'iso8601', numberingSystem: 'latn',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }); // throws RangeError for an unknown time zone
    formatters.set(timeZone, f);
  }
  return f.format(new Date(ms));
}

// Serialize calls inside this process (per user); the lock dir handles other processes.
const queues = new Map();
function inProcess(key, fn) {
  const prev = queues.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return run;
}

async function acquire(lockPath) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await mkdir(lockPath); // atomic: exactly one process succeeds
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    try {
      const st = await stat(lockPath);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        // Holder presumably crashed. rename is atomic, so only one breaker wins.
        const tomb = `${lockPath}.stale.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
        await rename(lockPath, tomb);
        await rm(tomb, { recursive: true, force: true });
        continue;
      }
    } catch (e) {
      if (e.code === 'ENOENT') continue; // released or broken meanwhile; retry now
      throw e;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for lock ${lockPath}`);
    await sleep(2 + Math.random() * 18);
  }
}

async function release(lockPath) {
  try { await rmdir(lockPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

async function readSends(file) {
  let text;
  try { text = await readFile(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const arr = JSON.parse(text); // corrupt state throws: fail closed, never send unchecked
  if (!Array.isArray(arr) || !arr.every(Number.isFinite)) throw new Error(`corrupt state file ${file}`);
  return arr;
}

// Write to a temp file, fsync, rename over the target, fsync the directory.
async function writeAtomic(file, data) {
  const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  const fh = await open(tmp, 'w');
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, file);
  try {
    const dh = await open(path.dirname(file), 'r');
    try { await dh.sync(); } finally { await dh.close(); }
  } catch { /* directory fsync is best effort */ }
}

export async function reserve({ userId, timeZone, channel, now }) {
  if (typeof userId !== 'string' || userId === '') throw new TypeError('userId must be a non-empty string');
  if (!CHANNELS.has(channel)) throw new TypeError(`unknown channel: ${channel}`);
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('now must be a valid Date');
  const stateDir = process.env.STATE_DIR;
  if (!stateDir) throw new Error('STATE_DIR is not set');

  const nowMs = now.getTime();
  const today = dayKey(nowMs, timeZone); // validates timeZone before touching state

  const id = sha(userId);
  const usersDir = path.join(stateDir, 'users');
  const locksDir = path.join(stateDir, 'locks');
  await mkdir(usersDir, { recursive: true });
  await mkdir(locksDir, { recursive: true });
  const file = path.join(usersDir, `${id}.json`);
  const lockPath = path.join(locksDir, `${id}.lock`);

  return inProcess(id, async () => {
    await acquire(lockPath);
    try {
      const sends = await readSends(file);
      const todayCount = sends.filter((t) => dayKey(t, timeZone) === today).length;
      if (todayCount >= DAILY_LIMIT) return { allowed: false, rule: 'daily-cap' };
      const kept = sends.filter((t) => t > nowMs - KEEP_MS);
      kept.push(nowMs);
      await writeAtomic(file, JSON.stringify(kept));
      return { allowed: true, rule: '' };
    } finally {
      await release(lockPath);
    }
  });
}
