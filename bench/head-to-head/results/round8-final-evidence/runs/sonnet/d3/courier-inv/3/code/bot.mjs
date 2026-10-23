// Daily marketing cap: at most DAILY_CAP messages per customer per local calendar day,
// across all channels and all worker processes.
//
// Concurrency design: no locks. Each (user, local day) has one append-only log file in
// STATE_DIR. A call appends one record (a single O_APPEND write, which the OS applies
// atomically at the end of the file), then replays the file in order. The first DAILY_CAP
// records in file order are the accepted ones; the call is allowed only if its own record
// is among them. File order is the same for every process, so exactly DAILY_CAP calls win
// no matter how they interleave, and a crash cannot leave a lock behind.
//
// A record is written before the worker sends. If a worker crashes between reserve() and
// the send, the slot stays used (the cap is never exceeded; at worst one send is lost).

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';

const DAILY_CAP = 2;
const RULE_DAILY_CAP = 'daily-cap';
const CHANNELS = new Set(['sms', 'email', 'push']);

const formatters = new Map();

// Calendar date (YYYY-MM-DD) of `now` in the given IANA time zone.
function localDay(now, timeZone) {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone,
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

function validate({ userId, timeZone, channel, now }) {
  if (typeof userId !== 'string' || userId === '') throw new TypeError('userId must be a non-empty string');
  if (typeof timeZone !== 'string' || timeZone === '') throw new TypeError('timeZone must be an IANA name');
  if (!CHANNELS.has(channel)) throw new RangeError(`unknown channel: ${channel}`);
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('now must be a valid Date');
}

export async function reserve({ userId, timeZone, channel, now }) {
  validate({ userId, timeZone, channel, now });
  const stateDir = process.env.STATE_DIR;
  if (!stateDir) throw new Error('STATE_DIR is not set');

  const day = localDay(now, timeZone); // throws RangeError for an unknown time zone
  const userDir = path.join(stateDir, 'users', createHash('sha256').update(userId).digest('hex'));
  const file = path.join(userDir, `${day}.log`);

  // Cheap exit: accepted records never disappear, so a full day stays full.
  const before = parse(await readIfExists(file));
  if (before.length >= DAILY_CAP) return { allowed: false, rule: RULE_DAILY_CAP };

  await mkdir(userDir, { recursive: true });
  const id = randomUUID();
  const record = { id, at: now.toISOString(), tz: timeZone, channel };
  const fh = await open(file, 'a');
  try {
    // Leading newline: a torn earlier write can never merge with this record.
    await fh.write(`\n${JSON.stringify(record)}\n`);
    await fh.datasync();
  } finally {
    await fh.close();
  }

  const accepted = parse(await readIfExists(file)).slice(0, DAILY_CAP);
  return accepted.includes(id) ? { allowed: true, rule: '' } : { allowed: false, rule: RULE_DAILY_CAP };
}

async function readIfExists(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

// Record ids in file order; unreadable lines are skipped.
function parse(text) {
  const ids = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r.id === 'string') ids.push(r.id);
    } catch {
      // torn or corrupt line: ignore
    }
  }
  return ids;
}
