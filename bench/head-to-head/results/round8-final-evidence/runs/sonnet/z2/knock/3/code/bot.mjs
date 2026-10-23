// Weekly digest SMS gate for US customers.
//
// Rules enforced here:
//  - A customer who opted out (STOP-type text or account page) gets no digest until they text START.
//  - Texts go out only 8:00 to 19:59 in the customer's own time zone (stricter than the 8am-9pm
//    federal TCPA window, because some states, e.g. Florida and Oklahoma, end at 8pm).
//  - One digest event (message.id) is sent at most once, even if the queue redelivers it
//    or several workers handle it at the same time.
//  - At most one digest per customer in any 6 days.
//  - When we cannot check a rule (bad time zone, bad data), we do not send.
//
// State is one JSON file per customer in STATE_DIR, changed only while holding a per-customer
// lock directory, so all worker processes on the machine see one consistent view.
// A digest is recorded as sent before it leaves, so a worker crash after trySend can lose
// a digest but never sends it twice.

import { mkdir, readFile, writeFile, rename, rmdir, stat, open } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

const FIRST_HOUR = 8; // inclusive, local time
const LAST_HOUR = 20; // exclusive, local time
const MIN_GAP_MS = 6 * 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 15_000;

const OPT_OUT_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'revoke', 'optout']);
const OPT_OUT_PHRASES = ['opt out', 'do not text', 'dont text', 'do not message', 'dont message', 'no more texts'];
const START_WORDS = new Set(['start', 'unstop']);
const HELP_WORDS = new Set(['help', 'info']);

const REPLY_STOP = 'You are unsubscribed from reminder digest texts and will get no more messages. Reply START to subscribe again.';
const REPLY_START = 'You are subscribed to the weekly reminder digest. About 1 msg per week. Msg&data rates may apply. Reply HELP for help, STOP to cancel.';
const REPLY_HELP = 'Weekly reminder digest. About 1 msg per week. Msg&data rates may apply. Reply STOP to cancel, START to resubscribe.';

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function userBase(userId) {
  const key = createHash('sha256').update(String(userId)).digest('hex');
  return path.join(stateDir(), `user-${key}`);
}

async function withLock(base, fn) {
  await mkdir(stateDir(), { recursive: true });
  const lock = `${base}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const s = await stat(lock);
        if (Date.now() - s.mtimeMs > LOCK_STALE_MS) await rmdir(lock).catch(() => {});
      } catch {
        /* lock vanished, retry */
      }
      if (Date.now() > deadline) throw new Error('could not get the customer lock in time');
      await sleep(5 + Math.random() * 15);
    }
  }
  try {
    return await fn();
  } finally {
    await rmdir(lock).catch(() => {});
  }
}

async function readState(base) {
  try {
    const s = JSON.parse(await readFile(`${base}.json`, 'utf8'));
    return { optOut: s.optOut ?? {}, sent: s.sent ?? {}, lastSent: s.lastSent ?? {} };
  } catch (e) {
    if (e.code === 'ENOENT') return { optOut: {}, sent: {}, lastSent: {} };
    throw e; // corrupt state: fail loudly, never guess
  }
}

async function writeState(base, state) {
  const tmp = `${base}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fh = await open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify(state));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, `${base}.json`);
}

function localHour(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).formatToParts(date);
  return Number(parts.find((p) => p.type === 'hour').value);
}

const isDate = (d) => d instanceof Date && !Number.isNaN(d.getTime());
const no = (reason) => ({ sent: false, reason });

export async function trySend({ user, message, now }) {
  if (!user?.id || !message?.id) return no('The user or message id is missing, so nothing was sent.');
  if (message.channel !== 'sms') return no('This gate only handles sms messages.');
  if (!isDate(now)) return no('The current time is not valid, so nothing was sent.');

  let hour;
  try {
    // Intl falls back to the server zone when timeZone is undefined, so check it first.
    if (typeof user.timezone !== 'string' || !user.timezone) throw new Error('no time zone');
    hour = localHour(now, user.timezone);
  } catch {
    return no('The customer time zone is missing or not valid, so the send-time rule cannot be checked.');
  }

  const base = userBase(user.id);
  return withLock(base, async () => {
    const state = await readState(base);
    if (state.optOut.sms) return no('The customer opted out of texts.');
    if (state.sent[message.id]) return no('This digest was already sent.');
    if (hour < FIRST_HOUR || hour >= LAST_HOUR) {
      return no('It is outside 8am to 8pm in the customer local time. Try again later.');
    }
    const last = state.lastSent.sms ? Date.parse(state.lastSent.sms) : NaN;
    if (!Number.isNaN(last) && now.getTime() - last < MIN_GAP_MS) {
      return no('The customer already got a digest in the last 6 days.');
    }
    state.sent[message.id] = now.toISOString();
    state.lastSent.sms = now.toISOString();
    await writeState(base, state);
    return { sent: true, reason: 'Allowed.' };
  });
}

async function setOptOut(userId, channel, value, now) {
  if (!userId || !channel) throw new TypeError('userId and channel are required');
  const base = userBase(userId);
  await withLock(base, async () => {
    const state = await readState(base);
    if (value) {
      if (state.optOut[channel]) return;
      state.optOut[channel] = (isDate(now) ? now : new Date()).toISOString();
    } else {
      if (!state.optOut[channel]) return;
      delete state.optOut[channel];
    }
    await writeState(base, state);
  });
}

export async function optOut(userId, channel) {
  await setOptOut(userId, channel, true);
}

// Returns { reply }: text we may send back right away (a required STOP/START/HELP answer),
// or null when we must stay silent. The caller sends the reply; this module sends nothing.
export async function handleInbound({ userId, channel, text, now }) {
  if (channel !== 'sms' || !userId || typeof text !== 'string') return { reply: null };
  const norm = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const words = norm.split(' ');

  // Any clear stop request counts, not only the exact keyword (FCC revocation rules).
  if (words.some((w) => OPT_OUT_WORDS.has(w)) || OPT_OUT_PHRASES.some((p) => norm.includes(p))) {
    await setOptOut(userId, channel, true, now);
    return { reply: REPLY_STOP };
  }
  if (START_WORDS.has(norm)) {
    await setOptOut(userId, channel, false, now);
    return { reply: REPLY_START };
  }
  if (HELP_WORDS.has(norm)) return { reply: REPLY_HELP };
  return { reply: null };
}
