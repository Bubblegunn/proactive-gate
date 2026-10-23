// Marketing frequency cap: at most DAILY_CAP marketing messages per customer per
// local calendar day (customer's own time zone), across all channels and workers.
//
// Shared state: one append-only log file per user in STATE_DIR. A call appends
// one attempt record (O_APPEND, so the OS places it at an exact position even
// with concurrent writers), then reads the log and replays it in file order.
// Each attempt is allowed if fewer than DAILY_CAP earlier allowed attempts fall
// on the same local day. File order is the single order every process agrees on,
// so no lock is needed and no lock can be left behind by a crashed worker.
// An attempt that was logged as allowed but whose worker died before sending
// still counts. That errs toward sending too few messages, never too many.

import { open, readFile, mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const DAILY_CAP = 2;
const RULE_DAILY_CAP = 'daily-cap';
const CHANNELS = new Set(['sms', 'email', 'push']);

const formatters = new Map();
function dayFormatter(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

// Local calendar day (e.g. "2026-10-23") of an instant in a time zone.
function localDay(ms, timeZone) {
  const parts = dayFormatter(timeZone).formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function logPath(dir, userId) {
  const name = createHash('sha256').update(userId).digest('hex');
  return path.join(dir, `user-${name}.log`);
}

function parseLog(text) {
  const records = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r.id === 'string' && Number.isFinite(r.t) && typeof r.tz === 'string') {
        records.push(r);
      }
    } catch {
      // torn write from a crashed process: ignore
    }
  }
  return records;
}

export async function reserve({ userId, timeZone, channel, now }) {
  if (typeof userId !== 'string' || userId === '') throw new TypeError('userId must be a non-empty string');
  if (!CHANNELS.has(channel)) throw new TypeError(`channel must be sms, email or push, got ${channel}`);
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('now must be a valid Date');
  const t = now.getTime();
  const day = localDay(t, timeZone); // throws RangeError for an unknown time zone

  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  await mkdir(dir, { recursive: true });

  const file = logPath(dir, userId);
  const id = randomUUID();
  const line = JSON.stringify({ id, userId, tz: timeZone, ch: channel, t });

  // Leading newline so a torn previous line cannot merge with this record.
  const fh = await open(file, 'a');
  try {
    await fh.write(`\n${line}\n`);
    await fh.sync();
  } finally {
    await fh.close();
  }

  const records = parseLog(await readFile(file, 'utf8'));
  const allowedTimes = []; // instants of allowed attempts so far, in file order
  for (const r of records) {
    const rDay = localDay(r.t, r.tz);
    let used = 0;
    for (const at of allowedTimes) if (localDay(at, r.tz) === rDay) used++;
    const ok = used < DAILY_CAP;
    if (r.id === id) return ok ? { allowed: true, rule: '' } : { allowed: false, rule: RULE_DAILY_CAP };
    if (ok) allowedTimes.push(r.t);
  }
  throw new Error('reservation record missing from log');
}
