import { mkdir, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const DAILY_CAP = 2;
const CHANNELS = new Set(['sms', 'email', 'push']);

// Local calendar day (YYYY-MM-DD) of `now` in the given IANA time zone.
function localDay(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// Each reservation is one file, created with O_EXCL ('wx'). The OS guarantees
// that only one process/call can create a given name, so no lock (and no stale
// lock after a crash) is needed. Slots 1..DAILY_CAP exist per user per local day;
// when all slots exist the cap is reached. A file stays after a restart, so the
// count survives. A crash after reserving but before sending counts as sent
// (the safe direction for a cap).
export async function reserve({ userId, timeZone, channel, now }) {
  if (typeof userId !== 'string' || userId === '') throw new TypeError('userId must be a non-empty string');
  if (!CHANNELS.has(channel)) throw new TypeError(`unknown channel: ${channel}`);
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('now must be a valid Date');
  const stateDir = process.env.STATE_DIR;
  if (!stateDir) throw new Error('STATE_DIR is not set');

  const day = localDay(now, timeZone); // throws RangeError on a bad time zone
  const dir = path.join(stateDir, 'marketing-cap');
  await mkdir(dir, { recursive: true });

  const user = createHash('sha256').update(userId).digest('hex');
  const record = JSON.stringify({ userId, timeZone, day, channel, at: now.toISOString() }) + '\n';

  for (let slot = 1; slot <= DAILY_CAP; slot++) {
    const file = path.join(dir, `${user}.${day}.${slot}`);
    let fh;
    try {
      fh = await open(file, 'wx');
    } catch (err) {
      if (err.code === 'EEXIST') continue;
      throw err;
    }
    try {
      await fh.writeFile(record);
      await fh.sync();
    } finally {
      await fh.close();
    }
    return { allowed: true, rule: '' };
  }
  return { allowed: false, rule: 'daily-cap' };
}
