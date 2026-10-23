// Marketing frequency cap: at most MAX_PER_DAY marketing messages per customer
// per local calendar day (midnight to midnight in the customer's time zone),
// across all channels and all worker processes.
//
// State: one file per reserved message in STATE_DIR. A slot file is created with
// the exclusive flag ("wx"), which the filesystem makes atomic across processes.
// No lock files exist, so a crashed or restarted worker cannot leave a stale lock.
// A slot that exists counts as sent, even if the worker died right after creating it.
import { open, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const MAX_PER_DAY = 2;
const CHANNELS = new Set(['sms', 'email', 'push']);

const deny = (rule) => ({ allowed: false, rule });

function localDay(now, timeZone) {
  // Throws RangeError for an unknown time zone.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

async function fsyncDir(dir) {
  try {
    const fd = await open(dir, 'r');
    try {
      await fd.sync();
    } finally {
      await fd.close();
    }
  } catch {
    // Directory fsync is not supported on every platform; the slot file is still created.
  }
}

export async function reserve({ userId, timeZone, channel, now }) {
  if (typeof userId !== 'string' || userId === '') return deny('invalid-user');
  if (!CHANNELS.has(channel)) return deny('invalid-channel');
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return deny('invalid-time');
  const stateDir = process.env.STATE_DIR;
  if (!stateDir) return deny('no-state-dir');

  let day;
  try {
    day = localDay(now, timeZone);
  } catch {
    return deny('invalid-time-zone');
  }

  // Fail closed on any input or storage problem: a held message is cheaper than a fourth one.
  const dir = path.resolve(stateDir);
  await mkdir(dir, { recursive: true });
  const userKey = createHash('sha256').update(userId).digest('hex');

  for (let slot = 1; slot <= MAX_PER_DAY; slot++) {
    const file = path.join(dir, `mkt-${userKey}-${day}-${slot}.json`);
    let fh;
    try {
      fh = await open(file, 'wx');
    } catch (err) {
      if (err.code === 'EEXIST') continue; // slot taken by another call or process
      throw err;
    }
    try {
      await fh.writeFile(
        JSON.stringify({ userId, timeZone, channel, day, slot, at: now.toISOString() }),
      );
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsyncDir(dir);
    return { allowed: true, rule: '' };
  }
  return deny('daily-cap');
}
