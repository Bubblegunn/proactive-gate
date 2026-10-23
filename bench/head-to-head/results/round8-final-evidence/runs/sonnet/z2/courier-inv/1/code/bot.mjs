// Compliance gate for the weekly digest text (US SMS).
//
// Rules enforced:
//  - No text to a customer who opted out (STOP-type reply or account page).
//  - No text outside 08:00-20:00 in the customer's own time zone (the strictest
//    US state window; the federal TCPA window is 08:00-21:00).
//  - A digest event id is sent at most once, even when the queue redelivers it
//    or several workers handle it at the same time.
//  - A stale digest (generated more than 24 hours ago) is not sent.
//  - Anything we cannot validate is refused (fail closed).
//
// State: one JSON file per user in STATE_DIR, changed only under a per-user
// lock file, so all worker processes on the machine see one consistent state.

import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

const WINDOW_START_HOUR = 8;
const WINDOW_END_HOUR = 20; // exclusive: last send minute is 19:59
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const LOCK_TIMEOUT_MS = 10_000;

const STOP_WORDS = new Set([
  'STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT',
]);
const STOP_PHRASES = [
  'OPT OUT', 'NO MORE', 'DO NOT TEXT', 'DONT TEXT', 'DO NOT MESSAGE', 'DONT MESSAGE',
  'LEAVE ME ALONE', 'TAKE ME OFF',
];
const START_WORDS = new Set(['START', 'UNSTOP']);
const HELP_WORDS = new Set(['HELP', 'INFO']);

const REPLY_STOP =
  'You are unsubscribed from digest texts and will get no more messages. Reply START to resubscribe.';
const REPLY_START =
  'You are subscribed to the weekly digest again. Msg freq: weekly. Msg&data rates may apply. Reply STOP to unsubscribe.';
const REPLY_HELP =
  'Weekly digest texts. Msg freq: weekly. Msg&data rates may apply. Reply STOP to unsubscribe.';

// ---------- storage ----------

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

function userPath(dir, userId) {
  const hash = createHash('sha256').update(String(userId)).digest('hex');
  return path.join(dir, `user-${hash}.json`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

async function lockIsStale(lockPath) {
  try {
    const pid = parseInt(await readFile(lockPath, 'utf8'), 10);
    if (Number.isInteger(pid) && pid > 0) return !pidAlive(pid);
    // Empty file: the owner is between create and write.
    const { mtimeMs } = await stat(lockPath);
    return Date.now() - mtimeMs > 5000;
  } catch {
    return false; // vanished; the next attempt will find out
  }
}

async function withLock(file, fn) {
  const lockPath = `${file}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fh = await open(lockPath, 'wx');
      await fh.writeFile(String(process.pid));
      await fh.close();
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (await lockIsStale(lockPath)) {
        await unlink(lockPath).catch(() => {});
        continue;
      }
      if (Date.now() > deadline) throw new Error('state lock timeout');
      await sleep(5 + Math.random() * 20);
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(lockPath).catch(() => {});
  }
}

async function readState(file) {
  try {
    const s = JSON.parse(await readFile(file, 'utf8'));
    return { optedOut: s.optedOut ?? {}, sent: s.sent ?? {} };
  } catch (e) {
    if (e.code === 'ENOENT') return { optedOut: {}, sent: {} };
    throw e; // corrupt state: fail closed rather than forget an opt-out
  }
}

async function writeState(file, state) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const fh = await open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify(state));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, file);
}

async function updateUser(userId, fn) {
  const dir = stateDir();
  await mkdir(dir, { recursive: true });
  const file = userPath(dir, userId);
  return withLock(file, async () => {
    const state = await readState(file);
    const result = await fn(state);
    if (result.dirty) await writeState(file, state);
    return result.value;
  });
}

// ---------- helpers ----------

const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;
const isValidDate = (d) => d instanceof Date && !Number.isNaN(d.getTime());

function localHour(timeZone, date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(date);
  return Number(parts.find((p) => p.type === 'hour').value);
}

function normalizeText(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[’']/g, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

function classifyInbound(text) {
  const norm = normalizeText(text);
  if (!norm) return 'other';
  if (START_WORDS.has(norm)) return 'start';
  const words = norm.split(' ');
  const padded = ` ${norm} `;
  if (words.some((w) => STOP_WORDS.has(w)) || STOP_PHRASES.some((p) => padded.includes(` ${p} `))) {
    return 'stop';
  }
  if (words.length <= 2 && words.some((w) => HELP_WORDS.has(w))) return 'help';
  return 'other';
}

// ---------- public API ----------

export async function trySend({ user, message, now }) {
  const no = (reason) => ({ sent: false, reason });
  try {
    if (!user || !isNonEmptyString(user.id)) return no('Missing user id.');
    if (!message || !isNonEmptyString(message.id)) return no('Missing message id.');
    if (message.channel !== 'sms') return no('This gate only handles the sms channel.');
    if (!isValidDate(now)) return no('Current time is not valid.');

    const created = new Date(message.createdAt);
    if (typeof message.createdAt !== 'string' || !isValidDate(created)) {
      return no('The digest creation time is not valid.');
    }
    if (now.getTime() - created.getTime() > MAX_AGE_MS) {
      return no('The digest is more than 24 hours old, so it is not sent.');
    }

    let hour;
    try {
      hour = localHour(user.timezone, now);
    } catch {
      return no('The customer time zone is missing or not valid, so quiet hours cannot be checked.');
    }

    return await updateUser(user.id, async (state) => {
      if (state.optedOut.sms || state.optedOut[message.channel]) {
        return { value: no('The customer opted out of texts.') };
      }
      if (state.sent[message.id]) {
        return { value: no('This digest was already sent.') };
      }
      if (hour < WINDOW_START_HOUR || hour >= WINDOW_END_HOUR) {
        return { value: no('It is outside 8am to 8pm in the customer local time.') };
      }
      for (const [id, at] of Object.entries(state.sent)) {
        if (now.getTime() - Date.parse(at) > SENT_RETENTION_MS) delete state.sent[id];
      }
      state.sent[message.id] = now.toISOString();
      return { value: { sent: true, reason: 'Allowed.' }, dirty: true };
    });
  } catch (e) {
    return no(`Could not check the customer state (${e.message}), so the text is held.`);
  }
}

export async function optOut(userId, channel) {
  if (!isNonEmptyString(userId)) throw new Error('userId is required');
  const ch = isNonEmptyString(channel) ? channel : 'sms';
  await updateUser(userId, async (state) => {
    if (!state.optedOut[ch]) state.optedOut[ch] = new Date().toISOString();
    return { value: undefined, dirty: true };
  });
}

export async function handleInbound({ userId, channel, text, now }) {
  if (channel !== 'sms' || !isNonEmptyString(userId)) return { handled: false };
  const kind = classifyInbound(text);
  if (kind === 'stop') {
    await optOut(userId, 'sms');
    return { handled: true, action: 'opt_out', reply: REPLY_STOP };
  }
  if (kind === 'start') {
    await updateUser(userId, async (state) => {
      delete state.optedOut.sms;
      return { value: undefined, dirty: true };
    });
    return { handled: true, action: 'opt_in', reply: REPLY_START };
  }
  if (kind === 'help') return { handled: true, action: 'help', reply: REPLY_HELP };
  return { handled: false };
}
