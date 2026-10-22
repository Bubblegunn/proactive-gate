// Proactive message limiter shared by several Node worker processes.
// State lives in STATE_DIR: one JSON file per customer, guarded by a
// per-customer lock directory (mkdir is atomic on a local filesystem).

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const LIMIT = 5;
const WINDOW_MS = 24 * 60 * 60 * 1000;
// Entries are kept longer than the window so a caller whose clock is
// slightly behind another worker still sees every message it must count.
const RETAIN_MS = 2 * WINDOW_MS;
const CHANNELS = new Set(['sms', 'push', 'chat']);
const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 10000;

export async function reserve(userId, channel, now) {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new TypeError('userId must be a non-empty string');
  }
  if (!CHANNELS.has(channel)) {
    throw new TypeError(`channel must be one of sms, push, chat (got ${String(channel)})`);
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }
  const stateDir = process.env.STATE_DIR;
  if (!stateDir) {
    throw new Error('STATE_DIR environment variable is not set');
  }

  const nowMs = now.getTime();
  const key = createHash('sha256').update(userId).digest('hex');
  const usersDir = join(stateDir, 'users');
  const locksDir = join(stateDir, 'locks');
  await mkdir(usersDir, { recursive: true });
  await mkdir(locksDir, { recursive: true });

  return withUserLock(join(locksDir, `${key}.lock`), async () => {
    const file = join(usersDir, `${key}.json`);
    const kept = (await readSent(file)).filter((t) => t > nowMs - RETAIN_MS);
    const inWindow = kept.filter((t) => t > nowMs - WINDOW_MS).sort((a, b) => a - b);

    if (inWindow.length < LIMIT) {
      kept.push(nowMs);
      await writeSent(file, kept);
      return {
        allowed: true,
        retryAt: null,
        reason: `Allowed: this customer has ${inWindow.length} proactive messages in the last 24 hours, limit is ${LIMIT} across all channels.`,
      };
    }

    // The message sent LIMIT positions from the newest is the one whose
    // 24-hour window must end before a new send fits.
    const retryAt = new Date(inWindow[inWindow.length - LIMIT] + WINDOW_MS);
    return {
      allowed: false,
      retryAt,
      reason: `Not sent: this customer already received ${LIMIT} proactive messages in the last 24 hours, which is the limit across all channels (this one was ${channel}). Next message allowed at ${retryAt.toISOString()}.`,
    };
  });
}

async function readSent(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const data = JSON.parse(text);
  if (!Array.isArray(data.sent)) {
    throw new Error(`corrupt limiter state file: ${file}`);
  }
  return data.sent;
}

async function writeSent(file, sent) {
  // Write to a unique temp file, then rename, so a crash never leaves a half-written state file.
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify({ sent }));
  await rename(tmp, file);
}

async function withUserLock(lockDir, fn) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await mkdir(lockDir);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      await breakIfStale(lockDir);
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for limiter lock: ${lockDir}`);
      }
      await sleep(5 + Math.random() * 15);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

// A worker that died while holding the lock leaves the directory behind.
// Move it aside (only one racer's rename can succeed) and let the caller retry.
async function breakIfStale(lockDir) {
  let info;
  try {
    info = await stat(lockDir);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  if (Date.now() - info.mtimeMs <= LOCK_STALE_MS) return;
  const aside = `${lockDir}.stale-${randomBytes(6).toString('hex')}`;
  try {
    await rename(lockDir, aside);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  await rm(aside, { recursive: true, force: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
