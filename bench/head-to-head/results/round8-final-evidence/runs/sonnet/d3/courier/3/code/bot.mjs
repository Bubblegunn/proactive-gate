// Marketing frequency cap: at most DAILY_LIMIT marketing messages per customer
// per local calendar day (midnight to midnight in the customer's time zone),
// counted across all channels and all worker processes.
//
// State lives only in files under STATE_DIR. Each allowed message claims one
// "slot" file by exclusive creation (open flag "wx"). The filesystem guarantees
// that only one process can create a given path, so no lock, no stale-lock
// cleanup and no read-modify-write race exist. A slot file never gets deleted
// by this code, so the count survives restarts. If a worker dies after
// claiming a slot but before sending, the customer is counted as messaged
// (the cap fails safe).

import { open, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const DAILY_LIMIT = 2;
const CHANNELS = new Set(['sms', 'email', 'push']);
const RULE_DAILY_CAP = 'daily-cap';

const formatters = new Map();

// Calendar date (YYYY-MM-DD) of `now` in the given IANA time zone.
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
  for (const { type, value } of fmt.formatToParts(now)) parts[type] = value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export async function reserve({ userId, timeZone, channel, now }) {
  if (typeof userId !== 'string' || userId === '') throw new TypeError('userId must be a non-empty string');
  if (typeof timeZone !== 'string' || timeZone === '') throw new TypeError('timeZone must be an IANA name');
  if (!CHANNELS.has(channel)) throw new TypeError(`unknown channel: ${channel}`);
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('now must be a valid Date');
  const stateDir = process.env.STATE_DIR;
  if (!stateDir) throw new Error('STATE_DIR is not set');

  const day = localDay(now, timeZone); // throws RangeError for an invalid time zone
  const dir = path.join(stateDir, 'marketing-daily-cap');
  await mkdir(dir, { recursive: true });

  const userKey = createHash('sha256').update(userId).digest('hex');
  const record = JSON.stringify({ userId, timeZone, channel, day, at: now.toISOString() }) + '\n';

  for (let slot = 0; slot < DAILY_LIMIT; slot++) {
    let handle;
    try {
      handle = await open(path.join(dir, `${userKey}.${day}.${slot}`), 'wx');
    } catch (err) {
      if (err.code === 'EEXIST') continue; // slot already used by an earlier message
      throw err;
    }
    try {
      await handle.writeFile(record);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return { allowed: true, rule: '' };
  }
  return { allowed: false, rule: RULE_DAILY_CAP };
}
