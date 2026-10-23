// Daily marketing-message cap, shared by all worker processes through STATE_DIR.
//
// State: one JSON file per user (named by the SHA-256 of the user id) holding the
// instants of the marketing messages already reserved. A per-user lock file
// (created with O_EXCL) serializes the read-check-write cycle across processes
// and across concurrent calls inside one process. State is written to a temp
// file, fsynced, and renamed, so a crash never leaves a half-written file.

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

const DAILY_LIMIT = 2;
const CHANNELS = new Set(['sms', 'email', 'push']);
// Local days are at most 26h apart in UTC terms from any instant of that day, so
// 3 days of history is always enough to evaluate "today" in any time zone.
const KEEP_MS = 3 * 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 15_000; // a live holder keeps the lock for milliseconds
const LOCK_TIMEOUT_MS = 30_000;

const RULE_DAILY_CAP = 'daily-cap';
const RULE_INVALID = 'invalid-request';
const RULE_UNAVAILABLE = 'state-unavailable';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const formatters = new Map();
function dayKey(ms, timeZone) {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(timeZone, fmt);
  }
  const parts = {};
  for (const p of fmt.formatToParts(ms)) parts[p.type] = p.value;
  return `${parts.era ?? ''}${parts.year}-${parts.month}-${parts.day}`;
}

async function acquireLock(lockPath) {
  const token = randomBytes(8).toString('hex');
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fh = await open(lockPath, 'wx');
      try {
        await fh.writeFile(`${process.pid}:${token}`);
      } finally {
        await fh.close();
      }
      return token;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    // Lock exists. Break it if the holder died long ago (crash/restart).
    try {
      const st = await stat(lockPath);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        const aside = `${lockPath}.stale.${token}`;
        await rename(lockPath, aside);
        await unlink(aside).catch(() => {});
        continue;
      }
    } catch (err) {
      if (err.code === 'ENOENT') continue; // released meanwhile
      throw err;
    }
    if (Date.now() > deadline) throw new Error('lock timeout');
    await sleep(3 + Math.random() * 20);
  }
}

async function releaseLock(lockPath, token) {
  try {
    const content = await readFile(lockPath, 'utf8');
    if (content.endsWith(`:${token}`)) await unlink(lockPath);
  } catch {
    // already gone or taken over as stale; nothing to release
  }
}

async function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const fh = await open(tmp, 'w');
    try {
      await fh.writeFile(text);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  try {
    const dir = await open(path.dirname(file), 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch {
    // directory fsync is best effort (not supported everywhere)
  }
}

async function readSent(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const data = JSON.parse(text); // corrupt state throws: fail closed, never reset
  if (!data || !Array.isArray(data.sent) || !data.sent.every(Number.isFinite)) {
    throw new Error('corrupt state file');
  }
  return data.sent;
}

export async function reserve({ userId, timeZone, channel, now } = {}) {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');

  const nowMs = now instanceof Date ? now.getTime() : NaN;
  if (
    typeof userId !== 'string' ||
    userId === '' ||
    typeof timeZone !== 'string' ||
    !CHANNELS.has(channel) ||
    !Number.isFinite(nowMs)
  ) {
    return { allowed: false, rule: RULE_INVALID };
  }
  let today;
  try {
    today = dayKey(nowMs, timeZone);
  } catch {
    return { allowed: false, rule: RULE_INVALID }; // unknown time zone
  }

  const base = path.join(dir, createHash('sha256').update(userId).digest('hex'));
  const stateFile = `${base}.json`;
  const lockPath = `${base}.lock`;

  let token;
  try {
    await mkdir(dir, { recursive: true });
    token = await acquireLock(lockPath);
  } catch {
    return { allowed: false, rule: RULE_UNAVAILABLE };
  }
  try {
    const sent = (await readSent(stateFile)).filter((t) => t > nowMs - KEEP_MS);
    const sentToday = sent.filter((t) => dayKey(t, timeZone) === today).length;
    if (sentToday >= DAILY_LIMIT) return { allowed: false, rule: RULE_DAILY_CAP };

    sent.push(nowMs);
    await writeAtomic(stateFile, JSON.stringify({ v: 1, sent }));
    return { allowed: true, rule: '' };
  } catch {
    return { allowed: false, rule: RULE_UNAVAILABLE }; // not stored => not allowed
  } finally {
    await releaseLock(lockPath, token);
  }
}
