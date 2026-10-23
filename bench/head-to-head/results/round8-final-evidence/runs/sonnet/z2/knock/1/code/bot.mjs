// Weekly digest SMS gate for US customers (TCPA / CTIA rules).
// No dependencies. State is one JSON file per user in STATE_DIR, guarded by a
// per-user lock file so several worker processes can share it.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Allowed sending window in the customer's local time. Federal TCPA rule is
// 8am-9pm; we use a narrower window to also satisfy stricter states
// (e.g. FL, OK, WA, MD: 8am-8pm; TX: Sunday only from noon).
const SEND_START_HOUR = 9;
const SEND_END_HOUR = 20; // last allowed minute is 19:59
const SUNDAY_START_HOUR = 12;
const MIN_DAYS_BETWEEN_DIGESTS = 6; // "weekly": a second digest inside 6 days is a duplicate
const MAX_DIGEST_AGE_MS = 48 * 3600 * 1000; // older content is stale
const SENT_ID_RETENTION_MS = 120 * 24 * 3600 * 1000;
const LOCK_STALE_MS = 15000;

const STOP_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'optout', 'revoke']);
const START_WORDS = new Set(['start', 'unstop']);
const STOP_PHRASES = [
  /\bopt[\s-]*out\b/, /\bunsubscribe\b/, /\bstop (?:the )?(?:text|texts|texting|messages|messaging|sending|digest|emails?)\b/,
  /\b(?:do not|dont|don't|please do not|no more) (?:text|message|contact)\b/, /\bno more (?:texts|messages)\b/,
  /\bremove me\b/, /\bleave me alone\b/, /\btake me off\b/, /\bdelete my number\b/,
];

export const HELP_REPLY = 'Reply STOP to unsubscribe from weekly digest texts. Msg&data rates may apply. Reply START to resubscribe.';
export const STOP_REPLY = 'You are unsubscribed and will get no more texts from us. Reply START to resubscribe.';
export const START_REPLY = 'You are subscribed to weekly digest texts again. Reply STOP to unsubscribe, HELP for help. Msg&data rates may apply.';

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

function userFile(userId) {
  const h = crypto.createHash('sha256').update(String(userId)).digest('hex');
  return path.join(stateDir(), `user-${h}.json`);
}

async function sleep(ms) { await new Promise((r) => setTimeout(r, ms)); }

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

async function withLock(userId, fn) {
  await fs.mkdir(stateDir(), { recursive: true });
  const lock = userFile(userId) + '.lock';
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      const fh = await fs.open(lock, 'wx');
      await fh.writeFile(String(process.pid));
      await fh.close();
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = await fs.stat(lock);
        let owner = NaN;
        try { owner = parseInt(await fs.readFile(lock, 'utf8'), 10); } catch { /* released meanwhile */ }
        const dead = Number.isFinite(owner) && !pidAlive(owner);
        if (dead || Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          // rename is atomic: only one stealer wins
          const grave = `${lock}.stale-${process.pid}-${crypto.randomUUID()}`;
          try { await fs.rename(lock, grave); await fs.unlink(grave); } catch { /* lost the race */ }
          continue;
        }
      } catch { continue; }
      if (Date.now() > deadline) throw new Error('could not get user lock');
      await sleep(5 + Math.random() * 15);
    }
  }
  try {
    return await fn();
  } finally {
    await fs.unlink(lock).catch(() => {});
  }
}

async function load(userId) {
  try {
    return JSON.parse(await fs.readFile(userFile(userId), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return { optedOut: {}, sent: {}, lastSentAt: null };
    throw e; // corrupt state: fail loudly rather than risk texting an opted-out customer
  }
}

async function save(userId, state) {
  const file = userFile(userId);
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const fh = await fs.open(tmp, 'w');
  try { await fh.writeFile(JSON.stringify(state)); await fh.sync(); } finally { await fh.close(); }
  await fs.rename(tmp, file);
}

function localParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hour: 'numeric', hourCycle: 'h23', weekday: 'short',
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return { hour: Number(p.hour), weekday: p.weekday };
}

function no(reason) { return { sent: false, reason }; }

export async function trySend({ user, message, now }) {
  if (!user || user.id == null || !message || message.id == null) return no('Missing user or message id, so nothing was sent.');
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return no('The current time is invalid, so nothing was sent.');
  if (message.channel !== 'sms') return no('Only the sms channel is handled here.');

  return withLock(user.id, async () => {
    const state = await load(user.id);
    const nowMs = now.getTime();

    if (state.sent[message.id]) return no('This digest was already sent.');
    if (state.optedOut[message.channel]) return no('The customer opted out of texts.');

    let local;
    try { local = localParts(now, user.timezone); } catch { return no('The customer timezone is unknown, so quiet hours cannot be checked.'); }
    const startHour = local.weekday === 'Sun' ? SUNDAY_START_HOUR : SEND_START_HOUR;
    if (local.hour < startHour || local.hour >= SEND_END_HOUR) {
      return no(`It is outside the allowed texting hours for the customer (${startHour}:00-${SEND_END_HOUR}:00 local time); try again later.`);
    }

    const created = Date.parse(message.createdAt);
    if (Number.isNaN(created)) return no('The digest creation time is invalid.');
    if (nowMs - created > MAX_DIGEST_AGE_MS) return no('The digest is more than 48 hours old, so it is stale.');

    if (state.lastSentAt != null && nowMs - state.lastSentAt < MIN_DAYS_BETWEEN_DIGESTS * 86400000) {
      return no('A digest was already sent to this customer in the last 6 days.');
    }

    for (const [id, at] of Object.entries(state.sent)) if (nowMs - at > SENT_ID_RETENTION_MS) delete state.sent[id];
    state.sent[message.id] = nowMs;
    state.lastSentAt = nowMs;
    await save(user.id, state);
    return { sent: true, reason: 'Allowed to send.' };
  });
}

function normalize(text) {
  return String(text ?? '').toLowerCase().replace(/[‘’]/g, "'").replace(/[^a-z0-9'\s-]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Returns { reply }: text the app may send back (a STOP confirmation, HELP or START answer), or null.
export async function handleInbound({ userId, channel, text, now }) {
  if (channel !== 'sms') return { reply: null };
  const t = normalize(text);
  const word = t.replace(/[\s-]+/g, '');
  const at = (now instanceof Date ? now : new Date()).getTime();

  if (STOP_WORDS.has(word) || STOP_WORDS.has(t) || STOP_PHRASES.some((re) => re.test(t)) || /^stop\b/.test(t)) {
    await optOut(userId, channel, at, 'inbound');
    return { reply: STOP_REPLY };
  }
  if (START_WORDS.has(t)) {
    await withLock(userId, async () => {
      const state = await load(userId);
      delete state.optedOut[channel];
      await save(userId, state);
    });
    return { reply: START_REPLY };
  }
  if (t === 'help' || t === 'info') return { reply: HELP_REPLY };
  return { reply: null };
}

export async function optOut(userId, channel, at = Date.now(), source = 'account') {
  await withLock(userId, async () => {
    const state = await load(userId);
    if (!state.optedOut[channel]) state.optedOut[channel] = { at, source };
    await save(userId, state);
  });
}
