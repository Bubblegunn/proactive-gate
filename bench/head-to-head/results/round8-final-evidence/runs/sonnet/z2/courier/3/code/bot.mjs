// SMS digest gate for US recipients (TCPA / CTIA rules).
//
// Rules enforced by trySend:
//   - one send per message id (the queue is at-least-once)
//   - no send to a user who opted out (account page or STOP-style text)
//   - only between 08:00 and 20:00 in the user's own time zone
//     (TCPA allows 08:00-21:00; 20:00 also satisfies the stricter state laws)
//   - no send of a stale digest, and at most one digest per user per 6 days
//   - any error or unusable input means "do not send"
//
// State: one JSON file per user in STATE_DIR, changed only while holding a
// per-user lock file, so several worker processes can share it.

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const OPEN_HOUR = 8;
const CLOSE_HOUR = 20; // exclusive
const MAX_AGE_MS = 48 * 3600 * 1000;
const MIN_GAP_MS = 6 * 24 * 3600 * 1000;
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 30_000;

const STOP_WORDS = new Set([
  'stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'optout', 'revoke', 'remove', 'unsub',
]);
const START_WORDS = new Set(['start', 'unstop', 'yes', 'subscribe', 'resume']);
const HELP_WORDS = new Set(['help', 'info']);
// Free-text revocation ("please stop texting me"). Deliberately excludes
// cancel/end, which are only treated as opt-out when they are the whole text.
const STOP_PHRASE = /\b(stop|unsubscribe|opt[\s-]?out|revoke|quit|remove me|(do not|dont|don't) (text|message|contact))\b/;

const REPLY_STOP =
  'Reminder bot: You are unsubscribed and will get no more texts. Reply START to subscribe again.';
const REPLY_START =
  'Reminder bot: You are subscribed to the weekly digest. Msg&data rates may apply. Reply HELP for help, STOP to cancel.';
const REPLY_START_BLOCKED =
  'Reminder bot: You turned the digest off in your account. Turn it on in your account settings to get texts again.';
const REPLY_HELP =
  'Reminder bot: weekly digest texts. Msg&data rates may apply. Reply STOP to cancel. For support, use the Help page in your account.';

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function userKey(userId) {
  return createHash('sha256').update(String(userId)).digest('hex');
}

async function withUserLock(userId, fn) {
  const dir = stateDir();
  await mkdir(dir, { recursive: true });
  const base = join(dir, `user-${userKey(userId)}`);
  const lockPath = `${base}.lock`;
  const started = Date.now();
  for (;;) {
    try {
      const fh = await open(lockPath, 'wx');
      await fh.close();
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const st = await stat(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) await unlink(lockPath).catch(() => {});
      } catch {
        // lock vanished; retry
      }
      if (Date.now() - started > LOCK_TIMEOUT_MS) throw new Error('lock timeout');
      await sleep(5 + Math.random() * 15);
    }
  }
  try {
    return await fn(`${base}.json`);
  } finally {
    await unlink(lockPath).catch(() => {});
  }
}

async function load(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { optOut: {}, sent: {}, lastSent: {} };
    throw err;
  }
  const s = JSON.parse(raw); // a corrupt file throws, so callers fail closed
  return { optOut: s.optOut ?? {}, sent: s.sent ?? {}, lastSent: s.lastSent ?? {} };
}

async function save(file, state) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fh = await open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify(state));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, file);
}

function localHour(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(now);
  return Number(parts.find((p) => p.type === 'hour').value);
}

const no = (reason) => ({ sent: false, reason });

export async function trySend({ user, message, now }) {
  try {
    if (!user?.id || !message?.id) return no('Missing user or message id.');
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) return no('Invalid current time.');
    if (message.channel !== 'sms') return no('Only the sms channel is supported.');
    const created = Date.parse(message.createdAt);
    if (Number.isNaN(created)) return no('Message has no valid creation time.');
    let hour;
    try {
      hour = localHour(now, user.timezone);
    } catch {
      return no('Unknown time zone, so quiet hours cannot be checked.');
    }

    return await withUserLock(user.id, async (file) => {
      const state = await load(file);
      const id = String(message.id);
      if (state.sent[id]) return no('This digest was already sent.');
      if (state.optOut.sms) return no('The user opted out of texts.');
      if (hour < OPEN_HOUR || hour >= CLOSE_HOUR) {
        return no('Quiet hours: it is outside 8am-8pm in the user\'s time zone.');
      }
      if (now.getTime() - created > MAX_AGE_MS) return no('The digest is too old to send.');
      const last = state.lastSent.sms ? Date.parse(state.lastSent.sms) : NaN;
      if (!Number.isNaN(last) && now.getTime() - last < MIN_GAP_MS) {
        return no('A digest was already sent to this user in the last 6 days.');
      }
      state.sent[id] = now.toISOString();
      state.lastSent.sms = now.toISOString();
      await save(file, state);
      return { sent: true, reason: 'OK to send.' };
    });
  } catch (err) {
    return no(`Could not check the send rules (${err.message}), so nothing was sent.`);
  }
}

function normalize(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function classify(text) {
  const t = normalize(text);
  const compact = t.replace(/[\s-]/g, '');
  if (STOP_WORDS.has(compact)) return 'stop';
  if (START_WORDS.has(compact)) return 'start';
  if (HELP_WORDS.has(compact)) return 'help';
  if (STOP_PHRASE.test(t)) return 'stop';
  return 'other';
}

// Returns { action, reply }. `reply` is the text to send back (or null).
// Replies to STOP/START/HELP are required by carriers and are not digests.
export async function handleInbound({ userId, channel, text, now }) {
  const ch = channel ?? 'sms';
  const kind = classify(text);
  if (kind === 'other') return { action: 'none', reply: null };
  if (kind === 'help') return { action: 'help', reply: REPLY_HELP };

  const at = (now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date()).toISOString();
  return withUserLock(userId, async (file) => {
    const state = await load(file);
    if (kind === 'stop') {
      // Keep an earlier account-page record if there is one.
      state.optOut[ch] = state.optOut[ch] ?? { at, source: 'keyword' };
      await save(file, state);
      return { action: 'opted_out', reply: REPLY_STOP };
    }
    // start
    const current = state.optOut[ch];
    if (!current) return { action: 'none', reply: null };
    if (current.source === 'account') return { action: 'none', reply: REPLY_START_BLOCKED };
    delete state.optOut[ch];
    await save(file, state);
    return { action: 'opted_in', reply: REPLY_START };
  });
}

export async function optOut(userId, channel = 'sms') {
  await withUserLock(userId, async (file) => {
    const state = await load(file);
    // An account-page opt-out always wins over a keyword one.
    state.optOut[channel] = { at: new Date().toISOString(), source: 'account' };
    await save(file, state);
  });
}
