// Marketing-message frequency cap shared by all sender workers.
//
// Rule "daily-cap": a customer gets at most DAILY_CAP marketing messages per
// calendar day (midnight to midnight in the customer's own time zone), counted
// across all channels.
//
// Storage: one JSON file per customer in $STATE_DIR/users/, holding the send
// timestamps (ms). Day membership is computed from the timestamps at check
// time, so a time zone change or DST shift cannot corrupt stored counts.
// Every read-check-write runs under a per-customer lock directory (mkdir is
// atomic), so workers and concurrent calls inside one worker never race.
// The state file is replaced atomically (temp file, fsync, rename), so a crash
// leaves either the old or the new state, never a partial file.

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const DAILY_CAP = 2;
const CHANNELS = new Set(['sms', 'email', 'push']);
const KEEP_MS = 7 * 24 * 60 * 60 * 1000; // history older than this cannot affect any time zone's current day
const LOCK_WAIT_MS = 30_000; // give up (and do NOT allow) after this long
const LOCK_STALE_MS = 30_000; // a lock directory untouched this long is abandoned

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- day key in the customer's time zone ---------------------------------

const formatters = new Map();
function dayKey(ms, timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  const p = {};
  for (const { type, value } of f.formatToParts(ms)) p[type] = value;
  return `${p.year}-${p.month}-${p.day}`;
}

// ---- cross-process lock ----------------------------------------------------

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

async function lockIsStale(lockDir) {
  let st;
  try {
    st = await stat(lockDir);
  } catch {
    return false; // already gone; caller retries mkdir
  }
  if (Date.now() - st.mtimeMs > LOCK_STALE_MS) return true;
  try {
    const owner = JSON.parse(await readFile(join(lockDir, 'owner'), 'utf8'));
    return !pidAlive(owner.pid);
  } catch {
    return false; // owner file not written yet (or just removed): not provably stale
  }
}

// Break an abandoned lock. Breakers are serialized by a second lock directory
// and re-check staleness inside it, so a breaker can never delete a lock that
// another process acquired legitimately in the meantime.
async function breakStale(lockDir) {
  const breakDir = `${lockDir}.break`;
  try {
    await mkdir(breakDir);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    try {
      const st = await stat(breakDir);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) await rm(breakDir, { recursive: true, force: true });
    } catch {}
    return;
  }
  try {
    if (await lockIsStale(lockDir)) await rm(lockDir, { recursive: true, force: true });
  } finally {
    await rm(breakDir, { recursive: true, force: true });
  }
}

async function acquire(lockDir) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      await mkdir(lockDir);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (await lockIsStale(lockDir)) await breakStale(lockDir);
      if (Date.now() > deadline) throw new Error(`reserve: timed out waiting for lock ${lockDir}`);
      await sleep(Math.min(50, 2 + attempt * 2) + Math.random() * 5);
      continue;
    }
    try {
      await writeFile(join(lockDir, 'owner'), JSON.stringify({ pid: process.pid, t: Date.now() }));
    } catch (e) {
      await rm(lockDir, { recursive: true, force: true });
      throw e;
    }
    return;
  }
}

async function release(lockDir) {
  await rm(lockDir, { recursive: true, force: true });
}

// Calls inside one process queue up here first, so they do not all spin on the file lock.
const localTails = new Map();
async function withLocalQueue(key, fn) {
  const prev = localTails.get(key) ?? Promise.resolve();
  let done;
  const mine = new Promise((r) => (done = r));
  const tail = prev.then(() => mine);
  localTails.set(key, tail);
  await prev;
  try {
    return await fn();
  } finally {
    done();
    if (localTails.get(key) === tail) localTails.delete(key);
  }
}

// ---- state file ------------------------------------------------------------

async function readSends(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const data = JSON.parse(text); // corrupt state throws: fail closed rather than reset the count
  if (!data || !Array.isArray(data.sends)) throw new Error(`reserve: unreadable state file ${file}`);
  return data.sends.filter((s) => Number.isFinite(s.t));
}

async function writeSends(file, sends) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fh = await open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify({ sends }));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, file);
  try {
    const dh = await open(join(file, '..'), 'r');
    try {
      await dh.sync();
    } finally {
      await dh.close();
    }
  } catch {}
}

// ---- public API ------------------------------------------------------------

export async function reserve({ userId, timeZone, channel, now }) {
  if (typeof userId !== 'string' || userId === '') throw new TypeError('reserve: userId must be a non-empty string');
  if (!CHANNELS.has(channel)) throw new TypeError(`reserve: unknown channel ${String(channel)}`);
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('reserve: now must be a valid Date');
  const nowMs = now.getTime();
  const today = dayKey(nowMs, timeZone); // throws RangeError on an invalid time zone

  const stateDir = process.env.STATE_DIR;
  if (!stateDir) throw new Error('reserve: STATE_DIR is not set');
  const dir = join(stateDir, 'users');
  await mkdir(dir, { recursive: true });

  // Hash the id: any string is a safe file name and ids never collide by sanitizing.
  const name = createHash('sha256').update(userId).digest('hex');
  const file = join(dir, `${name}.json`);
  const lockDir = join(dir, `${name}.lock`);

  return withLocalQueue(name, async () => {
    await acquire(lockDir);
    try {
      const sends = await readSends(file);
      const sentToday = sends.filter((s) => dayKey(s.t, timeZone) === today).length;
      if (sentToday >= DAILY_CAP) return { allowed: false, rule: 'daily-cap' };

      const kept = sends.filter((s) => s.t > nowMs - KEEP_MS);
      kept.push({ t: nowMs, c: channel });
      await writeSends(file, kept);
      return { allowed: true, rule: '' };
    } finally {
      await release(lockDir);
    }
  });
}
