import { promises as fs } from 'node:fs';
import path from 'node:path';

const HOUR = 3600e3;
const DAY = 24 * HOUR;

const MIN_DATA_POINTS = 5;
const MIN_CONFIDENCE = 0.6;
const PUSH_CONFIDENCE = 0.8;
const MIN_ACCOUNT_AGE_DAYS = 1;
const REPEAT_KEY_DAYS = 14;
const MAX_PER_DAY = 2;
const MAX_PER_WEEK = 5;
const MIN_GAP_MS = 4 * HOUR;
const QUIET_START = 22; // local hour, inclusive
const QUIET_END = 8; // local hour, exclusive
const MIN_HOUR_SAMPLES = 5;
const MAX_DISMISS_RATE = 0.7;
const KEEP_MS = 30 * DAY;

const no = (reason) => ({ send: false, surfaces: [], reason });

function localParts(date, timeZone) {
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    });
  } catch {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    });
  }
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

const num = (v) => typeof v === 'number' && Number.isFinite(v);

// ---- state: one JSON file per user, atomic writes, serialized in-process ----

let chain = Promise.resolve();
const serialize = (fn) => {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
};

function stateFile(userId) {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  const name = encodeURIComponent(String(userId)).replace(/%/g, '_');
  return { dir, file: path.join(dir, `user-${name}.json`) };
}

async function load(file) {
  try {
    const s = JSON.parse(await fs.readFile(file, 'utf8'));
    return Array.isArray(s.sent) ? s : { sent: [] };
  } catch {
    return { sent: [] };
  }
}

async function save(dir, file, state) {
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify(state));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, file);
}

// ---- decision ----

export async function decide({ user, candidate, context, now } = {}) {
  const valid =
    user && user.id != null && candidate && candidate.id != null && candidate.insight &&
    now instanceof Date && !Number.isNaN(now.getTime());
  if (!valid) return no('Input is incomplete, so nothing is shown.');

  const { insight } = candidate;
  const ctx = context || {};

  if (ctx.crisis === true) return no('The user is in a crisis, so no proactive message is shown.');
  if (user.focusMode === true) return no('The user has focus or do-not-disturb on.');
  if (num(user.accountAgeDays) && user.accountAgeDays < MIN_ACCOUNT_AGE_DAYS) {
    return no('The account is too new for proactive messages.');
  }
  if (!num(insight.dataPoints) || insight.dataPoints < MIN_DATA_POINTS) {
    return no('The finding rests on too few observations.');
  }
  if (!num(insight.confidence) || insight.confidence < MIN_CONFIDENCE) {
    return no('The finding is not confident enough to be useful.');
  }

  const { day, hour } = localParts(now, user.timezone);
  const stats = ctx.hourStats && ctx.hourStats[String(hour)];
  if (stats) {
    const acted = Number(stats.acted) || 0;
    const dismissed = Number(stats.dismissed) || 0;
    const total = acted + dismissed;
    if (total >= MIN_HOUR_SAMPLES && dismissed / total > MAX_DISMISS_RATE) {
      return no('The user mostly dismisses messages at this hour.');
    }
  }

  const quiet = hour >= QUIET_START || hour < QUIET_END;
  const surfaces = ['inApp'];
  if (!quiet && insight.confidence >= PUSH_CONFIDENCE) surfaces.unshift('push');

  return serialize(async () => {
    const { dir, file } = stateFile(user.id);
    const state = await load(file);
    const t = now.getTime();
    const sent = state.sent.filter((s) => t - s.t < KEEP_MS);

    if (sent.some((s) => s.id === candidate.id)) {
      return no('This message was already shown.');
    }
    if (insight.key != null && sent.some((s) => s.key === insight.key && t - s.t < REPEAT_KEY_DAYS * DAY)) {
      return no('The user already saw this finding recently.');
    }
    const recent = sent.filter((s) => s.t <= t);
    if (recent.some((s) => t - s.t < MIN_GAP_MS)) {
      return no('A message was shown a short time ago.');
    }
    const today = sent.filter((s) => localParts(new Date(s.t), user.timezone).day === day);
    if (today.length >= MAX_PER_DAY) return no('The daily limit of proactive messages is reached.');
    if (sent.filter((s) => t - s.t < 7 * DAY).length >= MAX_PER_WEEK) {
      return no('The weekly limit of proactive messages is reached.');
    }

    sent.push({ t, id: candidate.id, key: insight.key ?? null });
    await save(dir, file, { sent });
    return { send: true, surfaces, reason: null };
  });
}
