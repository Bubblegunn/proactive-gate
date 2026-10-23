// Marketing frequency cap: at most DAILY_CAP marketing messages per customer per
// local calendar day (midnight to midnight in the customer's time zone), across
// all channels. State lives only in files under STATE_DIR, so every worker
// process shares it and it survives restarts.
//
// Per customer: one JSON file (named by a hash of userId) holding the send
// timestamps, guarded by a lock directory created with mkdir (atomic on local
// file systems). Inside one process, calls for the same customer are also queued
// so they do not spin on the file lock.

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const DAILY_CAP = 2;
const CHANNELS = new Set(['sms', 'email', 'push']);
const RULE_DAILY_CAP = 'daily-cap';
const KEEP_MS = 3 * 24 * 3600 * 1000; // a local day is at most 25 h long
const LOCK_STALE_MS = 30_000; // a lock older than this belongs to a dead process
const LOCK_WAIT_MS = 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const formatters = new Map();
function localDay(ms, timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f.format(ms); // YYYY-MM-DD in that zone
}

// In-process queue per customer.
const queues = new Map();
function serialize(key, fn) {
  const prev = queues.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

async function acquire(lockDir) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      await mkdir(lockDir);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    try {
      const { mtimeMs } = await stat(lockDir);
      if (Date.now() - mtimeMs > LOCK_STALE_MS) {
        // Rename is atomic: only one contender wins the right to remove it.
        const grave = `${lockDir}.stale-${process.pid}-${randomBytes(4).toString('hex')}`;
        await rename(lockDir, grave);
        await rm(grave, { recursive: true, force: true });
        continue;
      }
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTEMPTY') continue; // lock just released/taken over
      throw err;
    }
    if (Date.now() > deadline) {
      throw new Error(`reserve: timed out waiting for lock ${lockDir}`);
    }
    await sleep(Math.min(5 + attempt * 2, 50) + Math.random() * 10);
  }
}

async function release(lockDir) {
  await rm(lockDir, { recursive: true, force: true });
}

async function readRecords(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  // Writes are atomic (temp file + rename), so a parse failure means real
  // corruption. Throw instead of treating it as empty: failing closed beats
  // sending over the cap.
  const data = JSON.parse(text);
  if (!data || !Array.isArray(data.sends)) throw new Error(`reserve: bad state file ${file}`);
  return data.sends;
}

async function writeRecords(file, userId, sends) {
  const tmp = `${file}.${process.pid}-${randomBytes(6).toString('hex')}.tmp`;
  const fh = await open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify({ userId, sends }));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, file);
  // Flush the directory entry so the rename survives a crash.
  try {
    const dh = await open(path.dirname(file), 'r');
    try {
      await dh.sync();
    } finally {
      await dh.close();
    }
  } catch {
    /* directory fsync is not supported everywhere */
  }
}

export async function reserve({ userId, timeZone, channel, now }) {
  if (typeof userId !== 'string' || userId === '') throw new TypeError('reserve: userId must be a non-empty string');
  if (!CHANNELS.has(channel)) throw new RangeError(`reserve: unknown channel ${String(channel)}`);
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('reserve: now must be a valid Date');
  if (typeof timeZone !== 'string') throw new TypeError('reserve: timeZone must be an IANA name');
  const nowMs = now.getTime();
  const today = localDay(nowMs, timeZone); // throws RangeError on an invalid zone

  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('reserve: STATE_DIR is not set');
  await mkdir(dir, { recursive: true });

  const id = createHash('sha256').update(userId).digest('hex');
  const file = path.join(dir, `${id}.json`);
  const lockDir = path.join(dir, `${id}.lock`);

  return serialize(id, async () => {
    await acquire(lockDir);
    try {
      const sends = await readRecords(file);
      const sentToday = sends.filter((s) => localDay(s.at, timeZone) === today).length;
      if (sentToday >= DAILY_CAP) return { allowed: false, rule: RULE_DAILY_CAP };

      const kept = sends.filter((s) => s.at > nowMs - KEEP_MS);
      kept.push({ at: nowMs, channel });
      await writeRecords(file, userId, kept);
      return { allowed: true, rule: '' };
    } finally {
      await release(lockDir);
    }
  });
}
