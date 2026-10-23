// SMS weekly digest gate for US customers.
// trySend decides if a digest text may go out now. handleInbound and optOut keep opt-out state.
// State is one JSON file per user in STATE_DIR, guarded by a per-user lock file,
// so every worker process sees the same state and opt-out wins over a send in progress.

import { promises as fs } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

const CHANNEL = 'sms';

// TCPA allows 8am to 9pm local time. Florida, Oklahoma and Maryland (and others) use 8am to 8pm,
// so we use the stricter window for everyone.
const WINDOW_START_HOUR = 8;
const WINDOW_END_HOUR = 20; // last send minute is 19:59
const MIN_GAP_MS = 6 * 24 * 3600 * 1000; // one digest per week, with a day of jitter room
const MAX_AGE_MS = 24 * 3600 * 1000; // a digest older than this is stale, do not send it
const MAX_FUTURE_MS = 5 * 60 * 1000; // allow small clock skew
const KEEP_IDS = 100;
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 30_000;

const STOP_WORDS = new Set([
  'stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'optout', 'opt out', 'revoke',
]);
const START_WORDS = new Set(['start', 'unstop', 'yes', 'subscribe', 'resume']);
const HELP_WORDS = new Set(['help', 'info']);
// Plain-language revocation ("please stop texting me") must also be honored.
const LOOSE_STOP = /\b(stop|unsubscribe|opt[\s-]?out|quit|revoke|cancel)\b/;

const REPLY_STOP =
  'You are unsubscribed from weekly digest texts. You will get no more messages. Reply START to resubscribe.';
const REPLY_HELP =
  'Weekly digest texts. Msg & data rates may apply. Reply STOP to unsubscribe. Manage settings in your account.';
const REPLY_START = 'You are subscribed to weekly digest texts. Reply STOP to unsubscribe, HELP for help.';
const REPLY_START_BLOCKED =
  'The weekly digest is turned off in your account. Turn it on in your account settings to get texts.';

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

function fileFor(userId) {
  const h = createHash('sha256').update(String(userId)).digest('hex');
  return path.join(stateDir(), `user-${h}.json`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function acquire(lockPath) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fh = await fs.open(lockPath, 'wx');
      await fh.close();
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    try {
      const st = await fs.stat(lockPath);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        // Holder crashed. Move the lock aside, so only one process reclaims it.
        const aside = `${lockPath}.stale.${process.pid}.${randomBytes(4).toString('hex')}`;
        await fs.rename(lockPath, aside).then(() => fs.unlink(aside), () => {});
        continue;
      }
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
    if (Date.now() > deadline) throw new Error('timed out waiting for state lock');
    await sleep(5 + Math.random() * 15);
  }
}

// Run fn(state) under the user lock. fn mutates state; state is saved atomically if fn returns.
async function withUser(userId, fn) {
  await fs.mkdir(stateDir(), { recursive: true });
  const file = fileFor(userId);
  const lock = `${file}.lock`;
  await acquire(lock);
  try {
    let state;
    try {
      state = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      state = {};
    }
    state.channels ??= {};
    const result = await fn(state);
    const tmp = `${file}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
    const fh = await fs.open(tmp, 'w');
    try {
      await fh.writeFile(JSON.stringify(state));
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, file);
    return result;
  } finally {
    await fs.unlink(lock).catch(() => {});
  }
}

function chan(state, channel) {
  return (state.channels[channel] ??= { stopped: false, accountOff: false, lastSentAt: null, sentIds: [] });
}

function localHour(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).formatToParts(date);
  return Number(parts.find((p) => p.type === 'hour').value);
}

function toDate(v) {
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function trySend({ user, message, now }) {
  const no = (reason) => ({ sent: false, reason });
  const nowD = toDate(now);
  if (!nowD) return no('Invalid current time, so the text was not sent.');
  if (!user?.id || !message?.id) return no('Missing user or message id, so the text was not sent.');
  if (message.channel !== CHANNEL) return no('This gate only handles sms messages.');

  return withUser(user.id, (state) => {
    const c = chan(state, CHANNEL);
    if (c.stopped) return no('Customer replied STOP to our texts.');
    if (c.accountOff) return no('Customer turned the digest off in their account.');
    if (c.sentIds.includes(message.id)) return no('This digest was already sent.');

    const created = toDate(message.createdAt);
    if (!created) return no('The digest has no valid creation time, so the text was not sent.');
    const age = nowD - created;
    if (age > MAX_AGE_MS) return no('The digest is more than 24 hours old, so it is stale.');
    if (age < -MAX_FUTURE_MS) return no('The digest creation time is in the future, so the text was not sent.');

    let hour;
    try {
      hour = localHour(nowD, user.timezone);
    } catch {
      return no('The customer time zone is missing or invalid, so quiet hours cannot be checked.');
    }
    if (hour < WINDOW_START_HOUR || hour >= WINDOW_END_HOUR) {
      return no('Quiet hours: it is outside 8am to 8pm for the customer. Try again later.');
    }

    if (c.lastSentAt != null && nowD - c.lastSentAt < MIN_GAP_MS) {
      return no('A digest text was already sent to this customer in the last week.');
    }

    c.lastSentAt = nowD.getTime();
    c.sentIds = [...c.sentIds, message.id].slice(-KEEP_IDS);
    return { sent: true, reason: 'Allowed.' };
  });
}

function classify(text) {
  const t = String(text).normalize('NFKC').toLowerCase().trim().replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, '').replace(/\s+/g, ' ');
  if (STOP_WORDS.has(t)) return 'stop';
  if (START_WORDS.has(t)) return 'start';
  if (HELP_WORDS.has(t)) return 'help';
  if (LOOSE_STOP.test(t)) return 'stop';
  return 'other';
}

// Returns { reply }: the text to send back (a required confirmation), or null for no reply.
export async function handleInbound({ userId, channel, text, now }) {
  if (channel !== CHANNEL || userId == null || typeof text !== 'string') return { reply: null };
  const kind = classify(text);
  if (kind === 'other') return { reply: null };
  if (kind === 'help') return { reply: REPLY_HELP };

  return withUser(userId, (state) => {
    const c = chan(state, CHANNEL);
    const at = toDate(now)?.getTime() ?? Date.now();
    if (kind === 'stop') {
      c.stopped = true;
      c.stoppedAt = at;
      return { reply: REPLY_STOP };
    }
    // START only undoes a text STOP. It never overrides an account-page opt-out.
    if (c.accountOff) return { reply: REPLY_START_BLOCKED };
    c.stopped = false;
    c.startedAt = at;
    return { reply: REPLY_START };
  });
}

export async function optOut(userId, channel) {
  if (channel !== CHANNEL || userId == null) return;
  await withUser(userId, (state) => {
    const c = chan(state, CHANNEL);
    c.accountOff = true;
  });
}
