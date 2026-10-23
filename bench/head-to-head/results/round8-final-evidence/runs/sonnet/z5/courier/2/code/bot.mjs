import { promises as fs } from 'node:fs';
import path from 'node:path';

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const MIN_DATA_POINTS = 5;
const MIN_CONFIDENCE = 0.6;
const KEY_COOLDOWN = 14 * DAY; // same finding is not shown again within this window
const MIN_GAP = 2 * HOUR; // between any two delivered messages
const MAX_PER_DAY = 3; // per user, per local day
const MAX_PUSH_PER_DAY = 1;
const QUIET_START = 22; // local hours [22, 8) get no push
const QUIET_END = 8;
const MIN_HOUR_SAMPLES = 5;
const KEEP = 30 * DAY;

const quiet = (reason) => ({ send: false, surfaces: [], reason });

function localParts(date, timezone) {
  let tz = timezone;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    tz = 'UTC';
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return { hour: Number(get('hour')), day: `${get('year')}-${get('month')}-${get('day')}` };
}

function stateFile() {
  const dir = process.env.STATE_DIR || path.join(process.cwd(), '.state');
  return { dir, file: path.join(dir, 'gate-state.json') };
}

async function load(file) {
  try {
    const s = JSON.parse(await fs.readFile(file, 'utf8'));
    return s && typeof s.users === 'object' && s.users ? s : { users: {} };
  } catch {
    return { users: {} };
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

let queue = Promise.resolve();

export function decide(input) {
  const run = queue.then(() => decideNow(input));
  queue = run.catch(() => {});
  return run;
}

async function decideNow({ user, candidate, context, now }) {
  const at = now instanceof Date ? now : new Date(now ?? Date.now());
  const t = at.getTime();
  if (!user || !candidate || Number.isNaN(t)) return quiet('Missing or invalid input.');

  if (context?.crisis) return quiet('The user may be in a crisis, so nothing is shown.');

  const ins = candidate.insight;
  if (!ins || typeof ins.key !== 'string' || !ins.key) return quiet('The insight is missing or has no key.');
  const dp = ins.dataPoints, conf = ins.confidence;
  if (!Number.isFinite(dp) || !Number.isFinite(conf)) return quiet('The insight data is invalid.');
  if (dp < MIN_DATA_POINTS) return quiet('Too few observations support this insight.');
  if (conf < MIN_CONFIDENCE) return quiet('Confidence in this insight is too low.');

  const { dir, file } = stateFile();
  const state = await load(file);
  const uid = String(user.id);
  const u = state.users[uid] ?? { sent: [] };
  u.sent = (u.sent || []).filter((e) => t - e.t < KEEP);

  if (candidate.id != null && u.sent.some((e) => e.id === candidate.id))
    return quiet('This message was already delivered.');
  if (u.sent.some((e) => e.key === ins.key && t - e.t < KEY_COOLDOWN))
    return quiet('The user already saw this finding recently.');

  const last = u.sent.reduce((m, e) => Math.max(m, e.t), -Infinity);
  if (t - last < MIN_GAP && t >= last) return quiet('Another message was shown a short time ago.');

  const { hour, day } = localParts(at, user.timezone);
  const today = u.sent.filter((e) => localParts(new Date(e.t), user.timezone).day === day);
  if (today.length >= MAX_PER_DAY) return quiet('The daily message limit is reached.');

  // Choose surfaces. In-app is passive; push interrupts.
  let push = true;
  if (user.focusMode) push = false;
  if (hour >= QUIET_START || hour < QUIET_END) push = false;
  if (today.some((e) => e.surfaces.includes('push')) && MAX_PUSH_PER_DAY <= today.filter((e) => e.surfaces.includes('push')).length) push = false;
  const hs = context?.hourStats?.[String(hour)];
  if (hs) {
    const acted = Number(hs.acted) || 0, dismissed = Number(hs.dismissed) || 0;
    if (acted + dismissed >= MIN_HOUR_SAMPLES && dismissed > acted) {
      // User mostly ignores messages at this hour: stay quiet entirely.
      return quiet('The user usually dismisses messages at this hour.');
    }
  }

  const surfaces = push ? ['push', 'inApp'] : ['inApp'];
  u.sent.push({ t, id: candidate.id ?? null, key: ins.key, surfaces });
  state.users[uid] = u;
  await save(dir, file, state);
  return { send: true, surfaces, reason: null };
}
