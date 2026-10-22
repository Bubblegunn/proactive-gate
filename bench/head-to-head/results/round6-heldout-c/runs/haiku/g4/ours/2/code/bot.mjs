import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

// Product limit: at most 5 proactive agent messages per customer in any
// rolling 24-hour window, across sms, push and chat together.
const LIMIT = 5;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const CHANNELS = new Set(['sms', 'push', 'chat']);

// A lock is held for a few milliseconds. A lock older than LOCK_STALE_MS
// is left by a crashed worker and is removed so the customer is not blocked.
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;

export async function reserve(userId, channel, now) {
  if (typeof userId !== 'string' || userId === '') {
    return refuse('Not sent: the customer id is missing or not a string.');
  }
  if (!CHANNELS.has(channel)) {
    return refuse('Not sent: the channel must be "sms", "push" or "chat".');
  }
  const nowMs = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(nowMs)) {
    return refuse('Not sent: the current time is not a valid Date.');
  }

  // Read STATE_DIR on every call so each worker sees the current setting.
  const stateDir = process.env.STATE_DIR;
  if (!stateDir) throw new Error('STATE_DIR is not set');
  await mkdir(stateDir, { recursive: true });

  // Hash the id so any string is a safe file name and no two ids share a file.
  const base = path.join(
    stateDir,
    'user-' + createHash('sha256').update(userId).digest('hex'),
  );
  const file = base + '.json';
  const lock = base + '.lock';

  return withLock(lock, async () => {
    const sends = (await readSends(file)).filter((s) => s.at > nowMs - WINDOW_MS);
    const count = sends.length;

    if (count >= LIMIT) {
      // Sorted oldest first. The send that frees a slot is the one at index
      // count - LIMIT; once it leaves the window, count drops to LIMIT - 1.
      const times = sends.map((s) => s.at).sort((a, b) => a - b);
      const retryAt = new Date(times[count - LIMIT] + WINDOW_MS);
      return {
        allowed: false,
        retryAt,
        reason:
          `Not sent: this customer already received ${count} proactive agent messages ` +
          `in the last 24 hours across all channels, which is the limit of ${LIMIT}. ` +
          `The next one can be sent at ${retryAt.toISOString()}.`,
      };
    }

    // Count the send before returning. If the write fails, the promise rejects
    // and the worker does not send.
    sends.push({ at: nowMs, channel });
    await writeAtomic(file, { sends });
    return {
      allowed: true,
      retryAt: null,
      reason: `Allowed: ${count + 1} of ${LIMIT} proactive messages used in the last 24 hours.`,
    };
  });
}

function refuse(reason) {
  return { allowed: false, retryAt: null, reason };
}

async function readSends(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  // A corrupt file throws here, so nothing is sent without a readable count.
  return JSON.parse(raw).sends;
}

async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(tmp, 'wx');
  try {
    await handle.writeFile(JSON.stringify(data));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
}

async function withLock(lockPath, critical) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx');
      await handle.close();
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      await removeIfStale(lockPath);
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for lock ${lockPath}`);
      }
      await sleep(5 + Math.random() * 15);
    }
  }
  try {
    return await critical();
  } finally {
    await unlink(lockPath).catch((err) => {
      if (err.code !== 'ENOENT') throw err;
    });
  }
}

async function removeIfStale(lockPath) {
  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs > LOCK_STALE_MS) await unlink(lockPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
