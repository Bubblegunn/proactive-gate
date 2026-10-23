import { open, mkdir, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const DAILY_CAP = 2;
const CHANNELS = new Set(['sms', 'email', 'push']);
const formatters = new Map();

// Local calendar day (YYYY-MM-DD) of `now` in the given IANA time zone.
function localDay(now, timeZone) {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone, calendar: 'gregory', numberingSystem: 'latn',
      year: 'numeric', month: '2-digit', day: '2-digit',
    });
    formatters.set(timeZone, fmt);
  }
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

async function fsyncDir(dir) {
  let fh;
  try {
    fh = await open(dir, 'r');
    await fh.sync();
  } catch {
    // directory fsync is not supported everywhere; the slot file itself is already synced
  } finally {
    await fh?.close();
  }
}

// Each allowed message owns one slot file <user>/<day>.<n>, created with O_EXCL.
// Exclusive creation is atomic across processes, so no lock (and no stale lock
// after a crash) is needed: whoever creates slot n has reserved send number n.
async function claimSlot(dir, day, n, record) {
  let fh;
  try {
    fh = await open(path.join(dir, `${day}.${n}`), 'wx');
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
  try {
    await fh.writeFile(record);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsyncDir(dir);
  return true;
}

export async function reserve({ userId, timeZone, channel, now }) {
  if (typeof userId !== 'string' || userId === '') throw new TypeError('userId must be a non-empty string');
  if (!CHANNELS.has(channel)) throw new TypeError(`unknown channel: ${channel}`);
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('now must be a valid Date');
  if (typeof timeZone !== 'string') throw new TypeError('timeZone must be a string');
  const day = localDay(now, timeZone); // throws RangeError for an unknown zone

  const root = process.env.STATE_DIR;
  if (!root) throw new Error('STATE_DIR is not set');
  const userHash = createHash('sha256').update(userId).digest('hex');
  const dir = path.join(root, 'slots', userHash);
  await mkdir(dir, { recursive: true });

  const record = JSON.stringify({ userId, channel, timeZone, day, at: now.toISOString() });
  let rule = 'daily-cap';
  let slot = 0;
  for (let n = 1; n <= DAILY_CAP; n++) {
    if (await claimSlot(dir, day, n, record)) { rule = ''; slot = n; break; }
  }

  // Decision log, one line per call, so a held message can be traced to its rule.
  const line = JSON.stringify({
    userId, channel, timeZone, day, at: now.toISOString(),
    allowed: rule === '', rule, slot, pid: process.pid,
  }) + '\n';
  await appendFile(path.join(root, 'decisions.log'), line).catch(() => {});

  return { allowed: rule === '', rule };
}
