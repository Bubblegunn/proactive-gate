import { promises as fs } from 'node:fs';
import path from 'node:path';

const MIN_DATA_POINTS = 5;
const MIN_CONFIDENCE = 0.6;
const PUSH_CONFIDENCE = 0.8;
const REPEAT_DAYS = 14;
const MAX_PER_24H = 2;
const MIN_GAP_MS = 4 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const QUIET_START = 22; // local hour, inclusive
const QUIET_END = 8; // local hour, exclusive
const MIN_HOUR_SAMPLES = 5;
const MAX_DISMISS_RATE = 0.6;

let queue = Promise.resolve();

export function decide(input) {
  const run = queue.then(() => decideNow(input));
  queue = run.catch(() => {});
  return run;
}

const no = (reason) => ({ send: false, surfaces: [], reason });

function localHour(now, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === 'hour').value);
    return Number.isInteger(h) ? h % 24 : null;
  } catch {
    return null;
  }
}

function stateFile() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return { dir, file: path.join(dir, 'proactive-state.json') };
}

async function load(file) {
  try {
    const s = JSON.parse(await fs.readFile(file, 'utf8'));
    return s && typeof s === 'object' && s.users ? s : { users: {} };
  } catch {
    return { users: {} };
  }
}

async function save(dir, file, state) {
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify(state));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, file);
}

async function decideNow({ user, candidate, context, now } = {}) {
  const insight = candidate?.insight;
  if (!user || !candidate || !insight) return no('Missing data, so nothing is shown.');
  const when = now instanceof Date ? now : new Date(now ?? Date.now());
  const t = when.getTime();
  if (Number.isNaN(t)) return no('Time is unknown, so nothing is shown.');

  if (context?.crisis === true) return no('User is in a crisis, so nothing is shown.');
  if (user.focusMode === true) return no('User has focus mode on, so nothing is shown.');

  const dp = Number(insight.dataPoints);
  const conf = Number(insight.confidence);
  if (!(dp >= MIN_DATA_POINTS)) return no('Finding rests on too few observations.');
  if (!(conf >= MIN_CONFIDENCE)) return no('Finding is not confident enough.');

  const hour = localHour(when, user.timezone);
  const quiet = hour === null || hour >= QUIET_START || hour < QUIET_END;

  const stats = hour === null ? null : context?.hourStats?.[String(hour)];
  if (stats) {
    const acted = Number(stats.acted) || 0;
    const dismissed = Number(stats.dismissed) || 0;
    const total = acted + dismissed;
    if (total >= MIN_HOUR_SAMPLES && dismissed / total > MAX_DISMISS_RATE) {
      return no('User usually dismisses messages at this hour.');
    }
  }

  const { dir, file } = stateFile();
  const state = await load(file);
  const uid = String(user.id);
  const u = state.users[uid] || { sent: [] };
  const key = String(insight.key);

  const recent = u.sent.filter((s) => t - s.at < DAY_MS && s.at <= t);
  if (u.sent.some((s) => s.key === key && t - s.at < REPEAT_DAYS * DAY_MS && s.at <= t)) {
    return no('User already saw this finding recently.');
  }
  if (recent.length >= MAX_PER_24H) return no('Daily message limit reached.');
  if (u.sent.some((s) => s.at <= t && t - s.at < MIN_GAP_MS)) return no('Last message was too recent.');

  const surfaces = !quiet && conf >= PUSH_CONFIDENCE ? ['push', 'inApp'] : ['inApp'];

  u.sent = u.sent.filter((s) => t - s.at < REPEAT_DAYS * DAY_MS || s.at > t);
  u.sent.push({ key, id: candidate.id, at: t });
  state.users[uid] = u;
  await save(dir, file, state);
  return { send: true, surfaces, reason: null };
}
