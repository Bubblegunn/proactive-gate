// Per-customer proactive message limit, shared by several worker processes.
//
// Rule: one customer may receive at most LIMIT proactive agent messages in any
// rolling WINDOW_MS period, counted across all channels together.
//
// State lives in STATE_DIR/customers/:
//   <sha256(userId)>.json  -> sorted array of { at: <epoch ms>, channel }
//   <sha256(userId)>.lock/ -> directory created with mkdir (atomic) as a mutex
//
// Every reserve() call takes the customer's lock, reads and prunes the entries,
// decides, writes the file atomically (temp file + rename), and releases the lock.
// Different customers use different locks and files, so they never wait on or
// affect each other.

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rmdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const LIMIT = 5;
const WINDOW_MS = 24 * 60 * 60 * 1000;
// Entries older than the window are kept this much longer before pruning, so a
// caller whose clock is slightly behind another worker still sees every message
// that is inside its own window.
const RETENTION_GRACE_MS = 60 * 1000;
const CHANNELS = new Set(['sms', 'push', 'chat']);

// A lock held longer than this is treated as left behind by a crashed process.
// The critical section takes a few milliseconds, so this is far above normal use.
const LOCK_STALE_MS = 10 * 1000;
const LOCK_WAIT_MS = 5 * 1000;

export async function reserve(userId, channel, now) {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new TypeError('userId must be a non-empty string');
  }
  if (!CHANNELS.has(channel)) {
    throw new TypeError('channel must be "sms", "push" or "chat"');
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }

  const stateDir = requireStateDir();
  const customersDir = join(stateDir, 'customers');
  await mkdir(customersDir, { recursive: true });

  const key = createHash('sha256').update(userId).digest('hex');
  const file = join(customersDir, `${key}.json`);
  const lockDir = join(customersDir, `${key}.lock`);

  await acquireLock(lockDir);
  try {
    return await decide(file, userId, channel, now.getTime());
  } finally {
    await releaseLock(lockDir);
  }
}

async function decide(file, userId, channel, nowMs) {
  const stored = await readEntries(file);
  const kept = stored.filter((e) => e.at > nowMs - WINDOW_MS - RETENTION_GRACE_MS);
  const inWindow = kept
    .filter((e) => e.at > nowMs - WINDOW_MS)
    .sort((a, b) => a.at - b.at);

  if (inWindow.length < LIMIT) {
    kept.push({ at: nowMs, channel });
    kept.sort((a, b) => a.at - b.at);
    await writeEntries(file, kept);
    return { allowed: true, retryAt: null, reason: 'Within the per-customer limit.' };
  }

  // The count only drops below LIMIT once enough of the oldest in-window
  // entries have left the window. With n entries in the window, the (n - LIMIT)th
  // entry (0-based) has to leave first, and it leaves at its time plus WINDOW_MS.
  const blockingAt = inWindow[inWindow.length - LIMIT].at;
  const retryAt = new Date(blockingAt + WINDOW_MS);

  if (kept.length !== stored.length) {
    await writeEntries(file, kept);
  }

  return {
    allowed: false,
    retryAt,
    reason:
      `Customer ${userId} already received ${LIMIT} proactive agent messages in the last 24 hours ` +
      `across all channels, so this ${channel} message was blocked. ` +
      `The next one can be sent at ${retryAt.toISOString()}.`,
  };
}

function requireStateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) {
    throw new Error('STATE_DIR environment variable is not set');
  }
  return dir;
}

async function readEntries(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  // A corrupt file must not be treated as empty, since that would allow more
  // messages than the limit. Throwing makes the caller skip the send.
  const entries = JSON.parse(text);
  if (!Array.isArray(entries) || !entries.every((e) => typeof e.at === 'number')) {
    throw new Error(`Corrupt rate-limit state file: ${file}`);
  }
  return entries;
}

async function writeEntries(file, entries) {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(tmp, 'w');
  try {
    await handle.writeFile(JSON.stringify(entries));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);

  // Sync the directory so the rename itself survives a power loss.
  const dirHandle = await open(join(file, '..'), 'r');
  try {
    await dirHandle.sync();
  } catch {
    // Some filesystems do not support directory fsync; the rename is still atomic.
  } finally {
    await dirHandle.close();
  }
}

async function acquireLock(lockDir) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await mkdir(lockDir);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }

    await removeIfStale(lockDir);

    if (Date.now() > deadline) {
      // Fail closed: if the lock cannot be obtained, the message is not sent.
      throw new Error(`Timed out waiting for rate-limit lock: ${lockDir}`);
    }
    await sleep(5 + Math.random() * 15);
  }
}

async function removeIfStale(lockDir) {
  let info;
  try {
    info = await stat(lockDir);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  if (Date.now() - info.mtimeMs < LOCK_STALE_MS) return;

  // Move the stale lock aside under a unique name, then re-check its age. Between
  // our stat and our rename another worker may have removed the stale lock and
  // created a fresh one; if the moved directory is fresh, put it back.
  // Residual risk: a rename-back can race with a new lock; the window is
  // microseconds and only reached after a 10 s stale lock, so it is accepted.
  const aside = `${lockDir}.stale-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    await rename(lockDir, aside);
  } catch {
    return;
  }
  const moved = await stat(aside).catch(() => null);
  if (moved && Date.now() - moved.mtimeMs < LOCK_STALE_MS) {
    await rename(aside, lockDir).catch(() => {});
    return;
  }
  await rmdir(aside).catch(() => {});
}

async function releaseLock(lockDir) {
  try {
    await rmdir(lockDir);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
