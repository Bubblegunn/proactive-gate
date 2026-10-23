import { promises as fs } from 'node:fs';
import path from 'node:path';

const MIN_ACCOUNT_AGE_DAYS = 3;
const MIN_DATA_POINTS = 5;
const MIN_CONFIDENCE = 0.6;
const SAME_KEY_COOLDOWN_MS = 14 * 24 * 3600 * 1000;
const MIN_GAP_MS = 3 * 3600 * 1000;
const MAX_PER_LOCAL_DAY = 2;
const MAX_PER_7_DAYS = 6;
const QUIET_START_HOUR = 22; // push is held from 22:00 to 07:59 local time
const QUIET_END_HOUR = 8;
const MIN_HOUR_SAMPLES = 5;
const MAX_DISMISS_RATIO = 0.6;
const RETAIN_MS = 30 * 24 * 3600 * 1000;

const quiet = (reason) => ({ send: false, surfaces: [], reason });

function localParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

function statePath() {
  const dir = process.env.STATE_DIR;
  return dir ? path.join(dir, 'proactive-state.json') : null;
}

async function loadState(file) {
  try {
    const s = JSON.parse(await fs.readFile(file, 'utf8'));
    if (s && typeof s === 'object' && s.users && typeof s.users === 'object') return s;
  } catch {
    // missing or unreadable file: start empty
  }
  return { users: {} };
}

async function saveState(file, state) {
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

// Calls run one at a time so a check and its write cannot interleave.
let chain = Promise.resolve();
function serialize(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

export async function decide(input) {
  return serialize(() => decideNow(input)).catch(() => quiet('Could not check the delivery history, so nothing is shown.'));
}

async function decideNow({ user, candidate, context, now } = {}) {
  const file = statePath();
  if (!file) return quiet('No state directory is configured, so nothing is shown.');
  if (!user || !candidate || !candidate.insight) return quiet('The request was incomplete, so nothing is shown.');

  const t = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(t)) return quiet('The current time is not valid, so nothing is shown.');

  if (context?.crisis === true) return quiet('The user is in a crisis, so no proactive messages are shown.');
  if (user.focusMode === true) return quiet('The user has focus or do-not-disturb on.');

  const age = Number(user.accountAgeDays);
  if (!Number.isFinite(age) || age < MIN_ACCOUNT_AGE_DAYS) {
    return quiet('The account is too new to have a useful finding.');
  }

  const { key, dataPoints, confidence } = candidate.insight;
  if (typeof key !== 'string' || key === '' || user.id == null) return quiet('The finding has no identifier.');
  if (!Number.isFinite(dataPoints) || dataPoints < MIN_DATA_POINTS) {
    return quiet('The finding rests on too few observations.');
  }
  if (!Number.isFinite(confidence) || confidence < MIN_CONFIDENCE) {
    return quiet('The finding is not confident enough.');
  }

  let local;
  try {
    local = localParts(new Date(t), user.timezone);
  } catch {
    return quiet('The user timezone is not valid, so the local time is unknown.');
  }

  await fs.mkdir(path.dirname(file), { recursive: true });
  const state = await loadState(file);
  const uid = String(user.id);
  const rec = state.users[uid] || { delivered: [] };
  rec.delivered = (rec.delivered || []).filter((d) => t - d.at < RETAIN_MS && d.at <= t + 60000);

  if (rec.delivered.some((d) => d.candidateId === candidate.id && candidate.id != null)) {
    return quiet('This message was already shown.');
  }
  if (rec.delivered.some((d) => d.key === key && t - d.at < SAME_KEY_COOLDOWN_MS)) {
    return quiet('The user already saw this finding recently.');
  }
  const last = rec.delivered.reduce((m, d) => Math.max(m, d.at), 0);
  if (last && t - last < MIN_GAP_MS) return quiet('A message was shown a short while ago.');
  const today = rec.delivered.filter((d) => localParts(new Date(d.at), user.timezone).day === local.day);
  if (today.length >= MAX_PER_LOCAL_DAY) return quiet('The daily limit of messages is reached.');
  if (rec.delivered.filter((d) => t - d.at < 7 * 24 * 3600 * 1000).length >= MAX_PER_7_DAYS) {
    return quiet('The weekly limit of messages is reached.');
  }

  const surfaces = ['inApp'];
  const isQuietHour = local.hour >= QUIET_START_HOUR || local.hour < QUIET_END_HOUR;
  const hs = context?.hourStats?.[String(local.hour)];
  const acted = Number(hs?.acted) || 0;
  const dismissed = Number(hs?.dismissed) || 0;
  const total = acted + dismissed;
  const badHour = total >= MIN_HOUR_SAMPLES && dismissed / total > MAX_DISMISS_RATIO;
  if (!isQuietHour && !badHour) surfaces.unshift('push');

  rec.delivered.push({ at: t, key, candidateId: candidate.id ?? null });
  state.users[uid] = rec;
  await saveState(file, state);

  return { send: true, surfaces, reason: null };
}
