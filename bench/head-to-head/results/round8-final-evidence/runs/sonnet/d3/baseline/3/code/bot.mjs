import { mkdir, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const DAILY_CAP = 2;
const CHANNELS = new Set(['sms', 'email', 'push']);

// Local calendar day (YYYY-MM-DD) of `now` in the given IANA time zone.
function localDay(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// Each allowed message claims one numbered slot file for (user, local day) with
// O_EXCL ('wx'). Creation is atomic across processes, so no lock is needed, a
// crashed worker cannot leave a stale lock, and the count survives restarts.
export async function reserve({ userId, timeZone, channel, now }) {
  if (typeof userId !== 'string' || userId === '') throw new TypeError('userId must be a non-empty string');
  if (!CHANNELS.has(channel)) throw new TypeError(`unknown channel: ${channel}`);
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('now must be a valid Date');
  const stateDir = process.env.STATE_DIR;
  if (!stateDir) throw new Error('STATE_DIR is not set');

  const day = localDay(now, timeZone); // throws RangeError on an invalid time zone
  const userKey = createHash('sha256').update(userId).digest('hex');
  const dir = path.join(stateDir, 'marketing', userKey, day);
  await mkdir(dir, { recursive: true });

  for (let slot = 1; slot <= DAILY_CAP; slot++) {
    let fh;
    try {
      fh = await open(path.join(dir, `slot-${slot}`), 'wx');
    } catch (err) {
      if (err.code === 'EEXIST') continue;
      throw err;
    }
    try {
      await fh.writeFile(JSON.stringify({ userId, timeZone, channel, at: now.toISOString() }) + '\n');
    } finally {
      await fh.close();
    }
    return { allowed: true, rule: '' };
  }
  return { allowed: false, rule: 'daily-cap' };
}
