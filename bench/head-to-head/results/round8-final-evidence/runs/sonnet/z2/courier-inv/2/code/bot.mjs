// Compliance gate for the weekly digest SMS (US customers).
//
// Rules enforced in trySend:
//   1. Channel must be "sms".
//   2. The customer must not have opted out (STOP reply or account page).
//   3. Quiet hours: no text before 09:00 or from 20:00 in the customer's local
//      time (strictest common US state rule; TCPA federal limit is 08:00-21:00).
//   4. The same digest event (message.id) is never sent twice, even if the queue
//      redelivers it or several workers race.
//   5. At most one digest per customer per local calendar week (Mon-Sun).
//
// State lives in STATE_DIR as small files. Every decision that must be atomic
// uses an exclusive create (flag "wx"), so concurrent worker processes need no
// lock file and a crashed worker cannot leave a stuck lock.

import { createHash } from 'node:crypto';
import { mkdir, writeFile, rename, rm, access } from 'node:fs/promises';
import path from 'node:path';

const QUIET_START_HOUR = 9; // first allowed local hour
const QUIET_END_HOUR = 20; // first blocked local hour in the evening

const STOP_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'revoke', 'optout']);
const START_WORDS = new Set(['start', 'unstop']);
const HELP_WORDS = new Set(['help', 'info']);

const REPLY_STOP = 'You have been unsubscribed and will get no more texts. Reply START to resubscribe.';
const REPLY_START = 'You are resubscribed to the weekly digest. Msg freq: weekly. Msg&data rates may apply. Reply STOP to unsubscribe.';
const REPLY_HELP = 'Weekly digest texts. Msg freq: weekly. Msg&data rates may apply. Reply STOP to unsubscribe.';

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

function key(...parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

async function file(kind, ...parts) {
  const dir = path.join(stateDir(), kind);
  await mkdir(dir, { recursive: true });
  return path.join(dir, key(...parts));
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// Exclusive create. Returns false when the file already exists.
async function claim(p, data) {
  try {
    await writeFile(p, JSON.stringify(data), { flag: 'wx' });
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
}

// Atomic write (temp file + rename) so readers never see a partial file.
async function writeAtomic(p, data) {
  const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, JSON.stringify(data));
  await rename(tmp, p);
}

const optOutFile = (userId, channel) => file('optout', userId, channel);

async function isOptedOut(userId, channel) {
  return exists(await optOutFile(userId, channel));
}

function localParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
  });
  const p = {};
  for (const { type, value } of fmt.formatToParts(date)) p[type] = Number(value);
  return p;
}

// Local calendar week, identified by the date of its Monday.
function weekKey({ year, month, day }) {
  const d = new Date(Date.UTC(year, month - 1, day));
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - sinceMonday);
  return d.toISOString().slice(0, 10);
}

export async function trySend({ user, message, now }) {
  const no = (reason) => ({ sent: false, reason });
  try {
    if (!user?.id || !message?.id) return no('The user or message id is missing.');
    if (message.channel !== 'sms') return no('This gate only handles SMS messages.');

    const when = now instanceof Date ? now : new Date(now);
    if (Number.isNaN(when.getTime())) return no('The current time is invalid.');

    let local;
    try {
      local = localParts(when, user.timezone);
    } catch {
      return no('The customer time zone is missing or invalid, so quiet hours cannot be checked.');
    }

    if (await isOptedOut(user.id, 'sms')) return no('The customer opted out of texts.');

    if (local.hour < QUIET_START_HOUR || local.hour >= QUIET_END_HOUR) {
      return no('It is outside 9am-8pm in the customer local time, so the text must wait.');
    }

    // Claim this digest event, then this customer-week. Each claim is atomic.
    const msgFile = await file('message', user.id, message.id);
    const wk = weekKey(local);
    const weekFile = await file('week', user.id, wk);
    const record = { userId: user.id, messageId: message.id, week: wk, at: when.toISOString() };

    if (!(await claim(msgFile, record))) return no('This digest was already sent.');
    if (!(await claim(weekFile, record))) {
      await rm(msgFile, { force: true });
      return no('The customer already got a digest this week.');
    }

    // An opt-out that landed while we were claiming still wins.
    if (await isOptedOut(user.id, 'sms')) {
      await rm(msgFile, { force: true });
      await rm(weekFile, { force: true });
      return no('The customer opted out of texts.');
    }

    return { sent: true, reason: 'Allowed.' };
  } catch (e) {
    return no(`The compliance check failed, so nothing was sent (${e.message}).`);
  }
}

function words(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/opt[\s-]*out/g, 'optout')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// Returns { action: 'stop' | 'start' | 'help' | 'none', reply }.
export async function handleInbound({ userId, channel, text, now }) {
  if (channel !== 'sms') return { action: 'none', reply: null };
  const w = words(text);

  // Any clear stop word counts, even inside a sentence ("please stop texting me").
  if (w.some((x) => STOP_WORDS.has(x))) {
    await optOut(userId, channel, now);
    return { action: 'stop', reply: REPLY_STOP };
  }
  // START and HELP only count as the whole message.
  if (w.length === 1 && START_WORDS.has(w[0])) {
    await rm(await optOutFile(userId, channel), { force: true });
    return { action: 'start', reply: REPLY_START };
  }
  if (w.length === 1 && HELP_WORDS.has(w[0])) {
    return { action: 'help', reply: REPLY_HELP };
  }
  return { action: 'none', reply: null };
}

export async function optOut(userId, channel = 'sms', now = new Date()) {
  const at = now instanceof Date ? now : new Date(now);
  await writeAtomic(await optOutFile(userId, channel), { userId, channel, at: at.toISOString() });
}
