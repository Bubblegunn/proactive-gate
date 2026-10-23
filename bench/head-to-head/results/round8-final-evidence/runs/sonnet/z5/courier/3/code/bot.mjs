import { promises as fs } from 'node:fs';
import path from 'node:path';

const MIN_DATA_POINTS = 5;
const MIN_CONFIDENCE = 0.7;
const MIN_ACCOUNT_AGE_DAYS = 1;
const QUIET_START_HOUR = 22; // local, inclusive
const QUIET_END_HOUR = 8; // local, exclusive
const MAX_PER_LOCAL_DAY = 3;
const MIN_GAP_MS = 2 * 60 * 60 * 1000;
const SAME_KEY_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;
const HISTORY_KEEP_MS = 60 * 24 * 60 * 60 * 1000;
const HOUR_MIN_SAMPLES = 5;
const HOUR_DISMISS_SHARE_BLOCK = 0.8;
const HOUR_ACT_SHARE_PUSH = 0.4;

const no = (reason) => ({ send: false, surfaces: [], reason });

function localParts(date, timezone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

function stateFile() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return { dir, file: path.join(dir, 'proactive-state.json') };
}

async function loadState(file) {
  try {
    const s = JSON.parse(await fs.readFile(file, 'utf8'));
    return { delivered: Array.isArray(s.delivered) ? s.delivered : [] };
  } catch (e) {
    if (e.code === 'ENOENT') return { delivered: [] };
    // Corrupt file: keep a copy, start fresh rather than crash.
    try { await fs.rename(file, `${file}.corrupt-${Date.now()}`); } catch {}
    return { delivered: [] };
  }
}

async function saveState(dir, file, state) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify(state));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, file);
}

// Serialize calls in this process so read-modify-write cannot interleave.
let chain = Promise.resolve();

export function decide(input) {
  const run = chain.then(() => decideInner(input));
  chain = run.catch(() => {});
  return run;
}

async function decideInner({ user, candidate, context, now } = {}) {
  const t = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(t)) return no('The current time is not valid, so nothing is shown.');
  const nowDate = new Date(t);
  if (!user || !candidate) return no('Missing user or candidate data, so nothing is shown.');

  // Safety first: these never depend on state.
  if (context?.crisis === true) return no('The user may be in a crisis, so no proactive message is shown.');
  if (user.focusMode === true) return no('The user has focus or do-not-disturb on.');

  const insight = candidate.insight ?? {};
  const dp = Number(insight.dataPoints);
  const conf = Number(insight.confidence);
  if (!Number.isFinite(dp) || dp < MIN_DATA_POINTS) return no('The finding rests on too few observations.');
  if (!Number.isFinite(conf) || conf < MIN_CONFIDENCE) return no('The finding is not confident enough.');
  if (!(Number(user.accountAgeDays) >= MIN_ACCOUNT_AGE_DAYS)) return no('The account is too new to know what is useful.');

  let local;
  try {
    local = localParts(nowDate, user.timezone);
  } catch {
    return no('The user timezone is unknown, so local quiet hours cannot be checked.');
  }
  if (local.hour >= QUIET_START_HOUR || local.hour < QUIET_END_HOUR) {
    return no('It is night time for the user.');
  }

  const hs = context?.hourStats?.[String(local.hour)];
  const acted = Math.max(0, Number(hs?.acted) || 0);
  const dismissed = Math.max(0, Number(hs?.dismissed) || 0);
  const total = acted + dismissed;
  if (total >= HOUR_MIN_SAMPLES && dismissed / total >= HOUR_DISMISS_SHARE_BLOCK) {
    return no('The user usually dismisses messages at this hour.');
  }

  const { dir, file } = stateFile();
  await fs.mkdir(dir, { recursive: true });
  const state = await loadState(file);
  const all = state.delivered.filter((d) => t - d.at < HISTORY_KEEP_MS);
  const history = all.filter((d) => d.userId === user.id);

  if (history.some((d) => d.id === candidate.id)) return no('This message was already shown.');
  if (insight.key != null && history.some((d) => d.key === insight.key && t - d.at < SAME_KEY_COOLDOWN_MS)) {
    return no('The same finding was shown recently.');
  }
  const last = history.reduce((m, d) => Math.max(m, d.at), -Infinity);
  if (t - last < MIN_GAP_MS && t >= last) return no('A message was shown a short time ago.');
  const today = history.filter((d) => {
    try { return localParts(new Date(d.at), user.timezone).day === local.day; } catch { return false; }
  }).length;
  if (today >= MAX_PER_LOCAL_DAY) return no('The daily limit of messages is reached.');

  const pushOk = total < HOUR_MIN_SAMPLES || acted / total >= HOUR_ACT_SHARE_PUSH;
  const surfaces = pushOk ? ['push', 'inApp'] : ['inApp'];

  all.push({ id: candidate.id, key: insight.key ?? null, userId: user.id, at: t });
  await saveState(dir, file, { delivered: all });
  return { send: true, surfaces, reason: null };
}
