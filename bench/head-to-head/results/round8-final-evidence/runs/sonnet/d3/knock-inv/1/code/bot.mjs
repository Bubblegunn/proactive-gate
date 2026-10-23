// Marketing frequency cap: at most DAILY_CAP marketing messages per customer per
// local calendar day (midnight to midnight in the customer's time zone), across
// all channels and all worker processes.
//
// Shared state lives only in STATE_DIR. Each allowed message claims a slot by
// creating a file with the exclusive flag ("wx"). The file system makes that
// operation atomic across processes and threads, so no lock is needed and a
// crashed or restarted worker cannot leave a stuck lock. A claimed slot is a
// file on disk, so it survives restarts.
//
//   STATE_DIR/<sha256(userId)>/<local-day>.<slot>
import { createHash } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';

const DAILY_CAP = 2;
const CHANNELS = new Set(['sms', 'email', 'push']);
const RULE_DAILY_CAP = 'daily-cap';

const formatters = new Map();

function localDay(now, timeZone) {
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
  for (const p of fmt.formatToParts(now)) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export async function reserve({ userId, timeZone, channel, now }) {
  if (typeof userId !== 'string' || userId === '') throw new TypeError('userId must be a non-empty string');
  if (typeof timeZone !== 'string') throw new TypeError('timeZone must be an IANA time zone name');
  if (!CHANNELS.has(channel)) throw new TypeError(`unknown channel: ${channel}`);
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('now must be a valid Date');
  const stateDir = process.env.STATE_DIR;
  if (!stateDir) throw new Error('STATE_DIR is not set');

  const day = localDay(now, timeZone); // throws RangeError for an invalid time zone
  const userDir = join(stateDir, createHash('sha256').update(userId).digest('hex'));
  await mkdir(userDir, { recursive: true });

  for (let slot = 1; slot <= DAILY_CAP; slot++) {
    let handle;
    try {
      handle = await open(join(userDir, `${day}.${slot}`), 'wx');
    } catch (err) {
      if (err.code === 'EEXIST') continue; // slot already used by an earlier message
      throw err;
    }
    try {
      await handle.writeFile(JSON.stringify({ userId, timeZone, channel, at: now.toISOString() }));
      await handle.sync();
    } finally {
      await handle.close();
    }
    return { allowed: true, rule: '' };
  }
  return { allowed: false, rule: RULE_DAILY_CAP };
}
