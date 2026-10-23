import { promises as fs } from 'node:fs';
import path from 'node:path';

const MIN_DATA_POINTS = 5;
const MIN_CONFIDENCE = 0.6;
const PUSH_MIN_CONFIDENCE = 0.8;
const QUIET_START_HOUR = 22; // local, inclusive
const QUIET_END_HOUR = 8; // local, exclusive
const MAX_PER_LOCAL_DAY = 2;
const MIN_GAP_MS = 4 * 3600 * 1000;
const SAME_KEY_COOLDOWN_MS = 7 * 24 * 3600 * 1000;
const HISTORY_KEEP_MS = 30 * 24 * 3600 * 1000;
const HOUR_MIN_SAMPLES = 5;
const HOUR_DISMISS_RATIO = 0.7;

const quiet = (reason) => ({ send: false, surfaces: [], reason });

function localParts(date, timezone) {
  const make = (tz) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
  let parts;
  try {
    parts = make(timezone || 'UTC');
  } catch {
    parts = make('UTC');
  }
  const get = (t) => parts.find((p) => p.type === t).value;
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

function inQuietHours(hour) {
  return QUIET_START_HOUR > QUIET_END_HOUR
    ? hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR
    : hour >= QUIET_START_HOUR && hour < QUIET_END_HOUR;
}

function hourEngagement(context, hour) {
  const s = context?.hourStats?.[String(hour)];
  const acted = Number(s?.acted) || 0;
  const dismissed = Number(s?.dismissed) || 0;
  return { acted, dismissed, total: acted + dismissed };
}

// Serialize decisions per user inside this process so read-modify-write is safe.
const queues = new Map();
function withLock(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

function stateFile(userId) {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return { dir, file: path.join(dir, `user-${encodeURIComponent(String(userId))}.json`) };
}

async function load(file) {
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    return Array.isArray(data.sent) ? data : { sent: [] };
  } catch {
    return { sent: [] };
  }
}

async function save(dir, file, data) {
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data));
  await fs.rename(tmp, file);
}

export async function decide({ user, candidate, context, now }) {
  if (!user || !candidate) return quiet('Missing user or candidate data, so nothing is shown.');
  const when = now instanceof Date ? now : new Date(now ?? Date.now());
  const insight = candidate.insight || {};

  if (context?.crisis) return quiet('The user is in a crisis, so no proactive messages are shown.');
  if (user.focusMode) return quiet('The user has focus or do-not-disturb on.');

  const { day, hour } = localParts(when, user.timezone);
  if (inQuietHours(hour)) return quiet('It is night for the user, so nothing is shown now.');

  const dataPoints = Number(insight.dataPoints);
  const confidence = Number(insight.confidence);
  if (!(dataPoints >= MIN_DATA_POINTS)) return quiet('The finding rests on too few observations.');
  if (!(confidence >= MIN_CONFIDENCE)) return quiet('The finding is not confident enough to show.');

  const eng = hourEngagement(context, hour);
  const dismissRatio = eng.total ? eng.dismissed / eng.total : 0;
  if (eng.total >= HOUR_MIN_SAMPLES && dismissRatio >= HOUR_DISMISS_RATIO) {
    return quiet('The user mostly dismisses messages at this hour.');
  }

  const { dir, file } = stateFile(user.id);
  return withLock(file, async () => {
    const state = await load(file);
    const t = when.getTime();
    const sent = state.sent.filter((s) => t - s.at < HISTORY_KEEP_MS);

    if (sent.some((s) => s.id === candidate.id)) {
      return quiet('This message was already shown.');
    }
    if (insight.key != null && sent.some((s) => s.key === insight.key && t - s.at < SAME_KEY_COOLDOWN_MS)) {
      return quiet('The user already saw this finding recently.');
    }
    if (sent.filter((s) => s.day === day).length >= MAX_PER_LOCAL_DAY) {
      return quiet('The daily limit of proactive messages is reached.');
    }
    const last = sent.reduce((m, s) => Math.max(m, s.at), -Infinity);
    if (t - last < MIN_GAP_MS && t >= last) {
      return quiet('A message was shown a short time ago.');
    }

    const surfaces = ['inApp'];
    if (confidence >= PUSH_MIN_CONFIDENCE && eng.acted >= eng.dismissed) surfaces.unshift('push');

    sent.push({ at: t, day, id: candidate.id, key: insight.key ?? null });
    await save(dir, file, { sent });
    return { send: true, surfaces, reason: null };
  });
}
