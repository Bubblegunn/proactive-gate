// Per-customer cap on proactive agent messages: at most LIMIT in any rolling
// 24-hour window, counted across sms, push and chat together.
//
// State lives in STATE_DIR so that separate worker processes share it:
//   users/<sha256(userId)>.json  { "sent": [{ "at": <ms>, "channel": "sms" }, ...] }
//   locks/<sha256(userId)>.lock  a directory; mkdir is atomic, so it serves as a mutex
// Each reserve() call takes the customer's lock, reads the list, decides, and
// writes the list back before releasing the lock. Other customers use other
// locks, so they never wait on each other.

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';

const LIMIT = 5;
const WINDOW_MS = 24 * 60 * 60 * 1000;
// Entries older than the window are dropped only after an extra hour, so a
// caller whose clock runs slightly behind another caller still sees every entry it needs.
const PRUNE_KEEP_MS = WINDOW_MS + 60 * 60 * 1000;
const CHANNELS = new Set(['sms', 'push', 'chat']);
// A lock older than this is assumed to belong to a crashed process. The critical
// section only does a few small file operations, so this is far longer than needed.
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 10_000;

export async function reserve(userId, channel, now) {
  if (typeof userId !== 'string' || userId === '') {
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

  const usersDir = path.join(stateDir, 'users');
  const locksDir = path.join(stateDir, 'locks');
  await mkdir(usersDir, { recursive: true });
  await mkdir(locksDir, { recursive: true });

  const key = createHash('sha256').update(userId, 'utf8').digest('hex');
  const file = path.join(usersDir, `${key}.json`);
  const nowMs = now.getTime();

  return withLock(path.join(locksDir, `${key}.lock`), async () => {
    const stored = await loadSent(file);
    const kept = stored.filter((e) => e.at > nowMs - PRUNE_KEEP_MS);
    const inWindow = kept
      .filter((e) => e.at > nowMs - WINDOW_MS)
      .map((e) => e.at)
      .sort((a, b) => a - b);

    if (inWindow.length < LIMIT) {
      kept.push({ at: nowMs, channel });
      await saveSent(file, kept);
      return {
        allowed: true,
        retryAt: null,
        reason: `Allowed: ${inWindow.length + 1} of ${LIMIT} proactive messages used in the last 24 hours.`,
      };
    }

    // The window must hold at most LIMIT - 1 entries before a new one is added.
    // Entry number inWindow.length - LIMIT (0-based) is the last one that has to age out.
    // Its 24-hour mark is the earliest moment the count drops enough.
    const retryMs = inWindow[inWindow.length - LIMIT] + WINDOW_MS;
    const retryAt = new Date(retryMs);
    return {
      allowed: false,
      retryAt,
      reason:
        `Not sent: this customer already received ${LIMIT} proactive agent messages in the last 24 hours ` +
        `(limit is ${LIMIT} per 24 hours across all channels combined). ` +
        `The next one can go after ${retryAt.toISOString()}.`,
    };
  });
}

async function withLock(lockPath, fn) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await mkdir(lockPath);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    await breakIfStale(lockPath);
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for lock ${path.basename(lockPath)}`);
    }
    await sleep(5 + Math.random() * 15);
  }
  try {
    return await fn();
  } finally {
    await rmdir(lockPath).catch((err) => {
      if (err.code !== 'ENOENT') throw err;
    });
  }
}

async function breakIfStale(lockPath) {
  let info;
  try {
    info = await stat(lockPath);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  if (Date.now() - info.mtimeMs < LOCK_STALE_MS) return;
  // Renaming first means only one process can remove this particular lock.
  const graveyard = `${lockPath}.stale-${randomBytes(6).toString('hex')}`;
  try {
    await rename(lockPath, graveyard);
    await rmdir(graveyard);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

async function loadSent(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  // A corrupt file throws here, so reserve() rejects and nothing is sent.
  const data = JSON.parse(raw);
  if (!data || !Array.isArray(data.sent)) {
    throw new Error(`corrupt state file: ${file}`);
  }
  return data.sent;
}

async function saveSent(file, sent) {
  // Write to a temp file, fsync it, then rename, so a crash never leaves a half-written state file.
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const handle = await open(tmp, 'w');
  try {
    await handle.writeFile(JSON.stringify({ sent }));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
