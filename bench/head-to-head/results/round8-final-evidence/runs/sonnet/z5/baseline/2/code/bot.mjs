import { promises as fs } from 'node:fs';
import path from 'node:path';

const MIN_DATA_POINTS = 5;
const MIN_CONFIDENCE = 0.6;
const PUSH_MIN_CONFIDENCE = 0.85;
const QUIET_START_HOUR = 22; // local, inclusive
const QUIET_END_HOUR = 8; // local, exclusive
const MAX_PER_LOCAL_DAY = 2;
const MIN_GAP_MS = 3 * 60 * 60 * 1000;
const SAME_INSIGHT_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;
const HOUR_MIN_SAMPLES = 5;
const HOUR_MAX_DISMISS_RATIO = 0.7;
const PUSH_HOUR_MIN_ACT_RATIO = 0.3;
const KEEP_IDS = 200;

const no = (reason) => ({ send: false, surfaces: [], reason });

function localParts(date, timezone) {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
    });
    const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
    return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
  } catch {
    return null;
  }
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// Serialise calls in this process; state writes are atomic for restarts.
let queue = Promise.resolve();

function stateFile() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return { dir, file: path.join(dir, 'gate-state.json') };
}

async function load(file) {
  try {
    const s = JSON.parse(await fs.readFile(file, 'utf8'));
    return s && typeof s === 'object' && s.users && typeof s.users === 'object' ? s : { users: {} };
  } catch (e) {
    if (e.code === 'ENOENT' || e instanceof SyntaxError) return { users: {} };
    throw e;
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

async function run({ user, candidate, context, now }) {
  const insight = candidate?.insight;
  if (!user?.id || !candidate || !insight || !(now instanceof Date) || isNaN(now)) {
    return no('Input was incomplete, so nothing is shown.');
  }

  // Safety first: these never depend on state.
  if (context?.crisis === true) return no('The user may be in a crisis, so no proactive messages are shown.');
  if (user.focusMode === true) return no('The user has focus or do-not-disturb on.');

  const local = localParts(now, user.timezone);
  if (!local) return no('The user timezone is unknown, so the local time cannot be checked.');
  if (local.hour >= QUIET_START_HOUR || local.hour < QUIET_END_HOUR) {
    return no('It is night for the user right now.');
  }

  if (!isNum(insight.dataPoints) || insight.dataPoints < MIN_DATA_POINTS) {
    return no('The finding rests on too few observations.');
  }
  if (!isNum(insight.confidence) || insight.confidence < MIN_CONFIDENCE) {
    return no('The finding is not confident enough.');
  }

  const stats = context?.hourStats?.[String(local.hour)];
  const acted = isNum(stats?.acted) ? stats.acted : 0;
  const dismissed = isNum(stats?.dismissed) ? stats.dismissed : 0;
  const total = acted + dismissed;
  if (total >= HOUR_MIN_SAMPLES && dismissed / total >= HOUR_MAX_DISMISS_RATIO) {
    return no('The user mostly dismisses messages at this hour.');
  }

  const { dir, file } = stateFile();
  const state = await load(file);
  const u = (state.users[user.id] ??= { deliveries: [], keys: {}, ids: [] });
  const nowMs = now.getTime();

  if (u.ids.includes(candidate.id)) return no('This message was already shown.');
  const keyTs = u.keys[insight.key];
  if (keyTs !== undefined && nowMs - keyTs < SAME_INSIGHT_COOLDOWN_MS) {
    return no('The user already saw this finding recently.');
  }

  const last = u.deliveries.reduce((m, d) => Math.max(m, d.ts), -Infinity);
  if (nowMs - last < MIN_GAP_MS && nowMs >= last) return no('Another message was shown a short time ago.');
  const today = u.deliveries.filter((d) => localParts(new Date(d.ts), user.timezone)?.day === local.day).length;
  if (today >= MAX_PER_LOCAL_DAY) return no('The daily limit of proactive messages is reached.');

  const pushOk =
    insight.confidence >= PUSH_MIN_CONFIDENCE &&
    !(total >= HOUR_MIN_SAMPLES && acted / total < PUSH_HOUR_MIN_ACT_RATIO);
  const surfaces = pushOk ? ['push', 'inApp'] : ['inApp'];

  u.deliveries.push({ ts: nowMs, key: insight.key, id: candidate.id });
  u.keys[insight.key] = nowMs;
  u.ids.push(candidate.id);
  u.ids = u.ids.slice(-KEEP_IDS);
  // prune old data
  u.deliveries = u.deliveries.filter((d) => nowMs - d.ts < 2 * 24 * 60 * 60 * 1000 || nowMs < d.ts);
  for (const k of Object.keys(u.keys)) if (nowMs - u.keys[k] >= SAME_INSIGHT_COOLDOWN_MS) delete u.keys[k];
  await save(dir, file, state);

  return { send: true, surfaces, reason: null };
}

export async function decide(input) {
  const p = queue.then(() => run(input ?? {}));
  queue = p.catch(() => {});
  return p;
}
