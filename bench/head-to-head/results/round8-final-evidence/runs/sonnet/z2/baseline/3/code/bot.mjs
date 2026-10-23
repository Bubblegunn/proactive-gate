import { mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

// Compliance rules enforced here (US SMS):
// - TCPA quiet hours: no texts before 8:00 or from 21:00 in the recipient's local time,
//   judged at send time (`now`), not at digest creation time.
// - Opt-out (STOP and similar words, or the account page) is honored at once and is
//   checked under the same lock as the send record, so a send cannot slip past it.
// - Each digest event id is sent at most once, across processes and restarts.
// - Fail closed: bad input or unreadable state means "do not send".

const QUIET_START_HOUR = 8; // first allowed local hour
const QUIET_END_HOUR = 21; // first blocked local hour in the evening
const LOCK_STALE_MS = 30_000;

const STOP_WORDS = new Set([
  'stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'revoke', 'optout', 'unsub',
]);
const STOP_PHRASES = [
  'opt out', 'opt me out', 'do not text', 'dont text', 'do not message', 'dont message',
  'no more texts', 'no more messages', 'remove me', 'take me off',
];
const START_WORDS = new Set(['start', 'unstop']);
const HELP_WORDS = new Set(['help', 'info']);

const REPLY_STOPPED =
  "You are unsubscribed and will not get more texts from us. Reply START to subscribe again.";
const REPLY_STARTED =
  'You are subscribed to the weekly digest again. Msg & data rates may apply. Reply HELP for help, STOP to cancel.';
const REPLY_HELP =
  'Weekly digest texts. Msg & data rates may apply. Reply STOP to cancel, START to resubscribe.';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

async function withLock(fn) {
  const dir = stateDir();
  await mkdir(dir, { recursive: true });
  const lockDir = path.join(dir, 'lock');
  for (;;) {
    try {
      await mkdir(lockDir);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = await stat(lockDir);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          const dead = `${lockDir}.stale.${process.pid}.${Math.random().toString(36).slice(2)}`;
          await rename(lockDir, dead);
          await rm(dead, { recursive: true, force: true });
          continue;
        }
      } catch {
        // lock vanished or another process took over; retry
      }
      await sleep(5 + Math.random() * 20);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

async function loadState() {
  const file = path.join(stateDir(), 'state.json');
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { optedOut: {}, sent: {} };
    throw e;
  }
  const s = JSON.parse(raw); // corrupt state throws: callers fail closed
  return { optedOut: s.optedOut ?? {}, sent: s.sent ?? {} };
}

async function saveState(state) {
  const file = path.join(stateDir(), 'state.json');
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, JSON.stringify(state));
  await rename(tmp, file);
}

const key = (userId, channel) => `${userId}|${channel}`;

function localHour(timeZone, date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    hour: 'numeric',
  }).formatToParts(date);
  return Number(parts.find((p) => p.type === 'hour').value) % 24;
}

function validDate(d) {
  return d instanceof Date && !Number.isNaN(d.getTime());
}

export async function trySend({ user, message, now }) {
  const no = (reason) => ({ sent: false, reason });
  try {
    if (!user?.id || !message?.id) return no('Missing user id or message id, so not sending.');
    if (message.channel !== 'sms') return no('Only the sms channel is supported.');
    if (!validDate(now)) return no('The current time is invalid, so not sending.');
    let hour;
    try {
      hour = localHour(user.timezone, now);
    } catch {
      return no('The customer time zone is unknown, so quiet hours cannot be checked.');
    }
    if (hour < QUIET_START_HOUR || hour >= QUIET_END_HOUR) {
      return no('It is outside 8am to 9pm in the customer local time, so not sending now.');
    }

    return await withLock(async () => {
      const state = await loadState();
      if (state.optedOut[key(user.id, message.channel)]) {
        return no('The customer opted out of texts.');
      }
      const msgKey = String(message.id);
      if (state.sent[msgKey]) return no('This digest was already sent.');
      state.sent[msgKey] = { userId: user.id, at: now.toISOString() };
      await saveState(state);
      return { sent: true, reason: 'Sent within allowed hours and recorded.' };
    });
  } catch {
    return no('Could not check the saved state, so not sending.');
  }
}

function classify(text) {
  const norm = String(text ?? '')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const tokens = norm.split(' ').filter(Boolean);
  if (tokens.some((t) => STOP_WORDS.has(t)) || STOP_PHRASES.some((p) => ` ${norm} `.includes(` ${p} `))) {
    return 'stop';
  }
  if (tokens.length === 1 && START_WORDS.has(tokens[0])) return 'start';
  if (tokens.length === 1 && HELP_WORDS.has(tokens[0])) return 'help';
  return 'other';
}

async function setOptOut(userId, channel, value, now) {
  return withLock(async () => {
    const state = await loadState();
    const k = key(userId, channel);
    const was = Boolean(state.optedOut[k]);
    if (value && !was) {
      state.optedOut[k] = { at: (validDate(now) ? now : new Date()).toISOString() };
      await saveState(state);
    } else if (!value && was) {
      delete state.optedOut[k];
      await saveState(state);
    }
    return was;
  });
}

// Returns { action, reply }. `reply` is the single text to send back, or null for none.
export async function handleInbound({ userId, channel, text, now }) {
  if (channel !== 'sms' || !userId) return { action: 'ignored', reply: null };
  const kind = classify(text);
  if (kind === 'stop') {
    const was = await setOptOut(userId, channel, true, now);
    return { action: 'opted_out', reply: was ? null : REPLY_STOPPED };
  }
  if (kind === 'start') {
    await setOptOut(userId, channel, false, now);
    return { action: 'opted_in', reply: REPLY_STARTED };
  }
  if (kind === 'help') return { action: 'help', reply: REPLY_HELP };
  return { action: 'none', reply: null };
}

export async function optOut(userId, channel) {
  await setOptOut(userId, channel ?? 'sms', true, new Date());
}
