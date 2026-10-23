// Weekly digest SMS gate for US recipients (TCPA / CTIA rules).
//
// Assumption: every user in the system already gave consent to receive texts
// from this bot. This module records opt-outs and re-subscribes; it cannot
// check the original consent record. If the digest contains promotional
// content, or the old consent only covered reminders, get new consent first.
//
// State: one JSON file per user in STATE_DIR. Each read-modify-write holds a
// per-user lock directory, so several worker processes can share the state.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rmdir, rm, stat, open } from 'node:fs/promises';
import path from 'node:path';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const SEND_START_HOUR = 9; // local time, inclusive. Stricter than the federal 8am.
const SEND_END_HOUR = 20; // local time, exclusive. FL, OK and MD stop at 8pm.
const SUNDAY_START_HOUR = 12; // Texas allows Sunday texts only from noon.
const MIN_GAP_MS = 6 * DAY; // at most one digest per week, with slack for jitter
const MAX_AGE_MS = 48 * HOUR; // do not send a digest that was generated long ago
const KEEP_IDS_MS = 30 * DAY;
const LOCK_WAIT_MS = 15000;

const STOP_WORDS = new Set([
  'stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'optout', 'revoke',
]);
const START_WORDS = new Set(['start', 'unstop']);
const STOP_PHRASES = [
  /\b(stop|unsubscribe|revoke)\b/,
  /\bopt[\s-]?out\b/,
  /\b(do not|dont|don't|never)\s+(text|message|contact|send|sms)\b/,
  /\bno more (texts?|messages?|sms)\b/,
  /\bremove (me|my number)\b/,
  /\btake me off\b/,
  /\bleave me alone\b/,
];

const REPLY_STOP =
  'You are unsubscribed and will get no more texts from us. Reply START to subscribe again.';
const REPLY_START = 'You are subscribed again. Reply STOP to unsubscribe, HELP for help.';
const REPLY_HELP =
  'Weekly digest texts from us. Msg&data rates may apply. Reply STOP to unsubscribe, START to resubscribe.';

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function userKey(userId) {
  return createHash('sha256').update(String(userId)).digest('hex');
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

async function lockIsStale(lockDir) {
  let pid;
  try {
    pid = Number((await readFile(path.join(lockDir, 'pid'), 'utf8')).trim());
  } catch {
    // The owner may be between mkdir and writing the pid file.
    try {
      return Date.now() - (await stat(lockDir)).mtimeMs > 2000;
    } catch {
      return false;
    }
  }
  return !Number.isInteger(pid) || pid <= 0 || !pidAlive(pid);
}

async function withLock(key, fn) {
  const dir = stateDir();
  await mkdir(dir, { recursive: true });
  const lockDir = path.join(dir, `${key}.lock`);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await mkdir(lockDir);
      await writeFile(path.join(lockDir, 'pid'), String(process.pid));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (await lockIsStale(lockDir)) {
        // Rename is atomic: only one process wins the right to remove it.
        const grave = `${lockDir}.dead.${process.pid}.${Date.now()}`;
        try {
          await rename(lockDir, grave);
          await rm(grave, { recursive: true, force: true });
        } catch {}
        continue;
      }
      if (Date.now() > deadline) throw new Error('could not get the state lock');
      await sleep(5 + Math.random() * 15);
    }
  }
  try {
    return await fn(path.join(dir, `${key}.json`));
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

async function load(file) {
  try {
    const s = JSON.parse(await readFile(file, 'utf8'));
    return { optedOut: {}, sent: {}, lastSentAt: null, ...s };
  } catch (e) {
    if (e.code === 'ENOENT') return { optedOut: {}, sent: {}, lastSentAt: null };
    throw e; // corrupt state: fail closed, the queue redelivers
  }
}

async function save(file, state) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fh = await open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify(state));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, file);
}

function localParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return { weekday: get('weekday'), hour: Number(get('hour')) };
}

function deny(reason) {
  return { sent: false, reason };
}

export async function trySend({ user, message, now }) {
  if (!user?.id || !message?.id) return deny('Missing user or message id.');
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return deny('Invalid current time.');
  if (message.channel !== 'sms') return deny('This gate only handles the sms channel.');

  const created = Date.parse(message.createdAt);
  if (Number.isNaN(created)) return deny('The digest has no valid creation time.');
  if (now.getTime() - created > MAX_AGE_MS) return deny('The digest is too old to send.');

  let local;
  try {
    local = localParts(now, user.timezone);
  } catch {
    return deny('The user time zone is unknown, so quiet hours cannot be checked.');
  }

  const key = userKey(user.id);
  return withLock(key, async (file) => {
    const state = await load(file);
    const msgId = String(message.id);

    if (state.sent[msgId] !== undefined) return deny('This digest was already sent.');
    if (state.optedOut.sms) return deny('The user opted out of texts.');

    const start = local.weekday === 'Sun' ? SUNDAY_START_HOUR : SEND_START_HOUR;
    if (local.hour < start || local.hour >= SEND_END_HOUR) {
      return deny(`Outside allowed hours for the user (${start}:00 to ${SEND_END_HOUR}:00 local time).`);
    }

    if (state.lastSentAt !== null && now.getTime() - state.lastSentAt < MIN_GAP_MS) {
      return deny('A digest was already sent to this user in the past week.');
    }

    for (const [id, at] of Object.entries(state.sent)) {
      if (now.getTime() - at > KEEP_IDS_MS) delete state.sent[id];
    }
    state.sent[msgId] = now.getTime();
    state.lastSentAt = now.getTime();
    await save(file, state);
    return { sent: true, reason: 'OK to send.' };
  });
}

function classify(text) {
  const t = String(text ?? '').toLowerCase().trim();
  const word = t.replace(/[^a-z0-9\s']/g, '').replace(/\s+/g, ' ').trim();
  if (STOP_WORDS.has(word)) return 'stop';
  if (START_WORDS.has(word)) return 'start';
  if (word === 'help' || word === 'info') return 'help';
  if (STOP_PHRASES.some((re) => re.test(t))) return 'stop';
  return 'other';
}

async function setOptOut(userId, channel, value, now) {
  await withLock(userKey(userId), async (file) => {
    const state = await load(file);
    if (value) state.optedOut[channel] = now.getTime();
    else delete state.optedOut[channel];
    await save(file, state);
  });
}

export async function optOut(userId, channel) {
  await setOptOut(userId, channel, true, new Date());
}

// Returns { action, reply }. The app sends `reply` (if any); this code sends nothing.
export async function handleInbound({ userId, channel, text, now }) {
  if (channel !== 'sms') return { action: 'ignored', reply: null };
  const when = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  switch (classify(text)) {
    case 'stop':
      await setOptOut(userId, channel, true, when);
      return { action: 'opted-out', reply: REPLY_STOP };
    case 'start':
      await setOptOut(userId, channel, false, when);
      return { action: 'opted-in', reply: REPLY_START };
    case 'help':
      return { action: 'help', reply: REPLY_HELP };
    default:
      return { action: 'none', reply: null };
  }
}
