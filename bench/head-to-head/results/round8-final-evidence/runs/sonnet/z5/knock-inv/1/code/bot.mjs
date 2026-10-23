import { mkdir, readFile, writeFile, rename, rmdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const MIN_CONFIDENCE = 0.6;
const MIN_DATA_POINTS = 5;
const PUSH_CONFIDENCE = 0.85;
const QUIET_START = 22; // local hour, inclusive
const QUIET_END = 8; // local hour, exclusive
const MAX_PER_DAY = 1;
const MAX_PER_WEEK = 3;
const MIN_GAP_MS = 6 * 3600e3;
const SAME_KEY_MS = 14 * 86400e3;
const WEEK_MS = 7 * 86400e3;
const MIN_HOUR_SAMPLES = 5;
const MAX_DISMISS_SHARE = 0.6;
const PUSH_MIN_ACT_SHARE = 0.5;
const PUSH_MIN_ACTED = 3;

const quiet = (reason) => ({ send: false, surfaces: [], reason });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function localParts(date, timeZone) {
  try {
    const f = new Intl.DateTimeFormat('en-CA', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    });
    const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
    return { hour: Number(p.hour), day: `${p.year}-${p.month}-${p.day}` };
  } catch {
    return null;
  }
}

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const count = (n) => (isNum(n) && n > 0 ? n : 0);

function userFile(dir, id) {
  return join(dir, `user-${createHash('sha256').update(String(id)).digest('hex').slice(0, 32)}.json`);
}

// Cross-process lock: mkdir is atomic. Stale locks (>10s) are removed.
async function withLock(dir, fn) {
  const lock = join(dir, '.lock');
  for (let i = 0; ; i++) {
    try {
      await mkdir(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - (await stat(lock)).mtimeMs > 10000) await rmdir(lock);
      } catch {}
      if (i > 2000) throw new Error('state lock timeout');
      await sleep(5 + Math.random() * 10);
    }
  }
  try {
    return await fn();
  } finally {
    await rmdir(lock).catch(() => {});
  }
}

async function load(file) {
  try {
    const s = JSON.parse(await readFile(file, 'utf8'));
    return Array.isArray(s.sent) ? s : { sent: [] };
  } catch {
    return { sent: [] };
  }
}

async function save(file, state) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(state));
  await rename(tmp, file);
}

export async function decide({ user, candidate, context, now } = {}) {
  const t = now instanceof Date ? now : new Date(now ?? Date.now());
  if (!user?.id || !candidate?.id || !isNum(t.getTime())) return quiet('The request was missing required details, so nothing is shown.');
  const insight = candidate.insight;
  if (!insight?.key) return quiet('There is no finding to show.');

  // Safety first: never interrupt a crisis or a focus session.
  if (context?.crisis === true) return quiet('The user is in a crisis, so no proactive message is shown.');
  if (user.focusMode === true) return quiet('The user has focus mode on, so nothing is shown.');

  const local = localParts(t, user.timezone);
  if (!local) return quiet('The local time is unknown, so nothing is shown.');
  if (local.hour >= QUIET_START || local.hour < QUIET_END) return quiet('It is night for the user, so nothing is shown.');

  if (!isNum(insight.confidence) || insight.confidence < MIN_CONFIDENCE || count(insight.dataPoints) < MIN_DATA_POINTS) {
    return quiet('The finding is not solid enough to be useful yet.');
  }

  const h = context?.hourStats?.[String(local.hour)];
  const acted = count(h?.acted);
  const dismissed = count(h?.dismissed);
  const total = acted + dismissed;
  if (total >= MIN_HOUR_SAMPLES && dismissed / total > MAX_DISMISS_SHARE) {
    return quiet('The user usually dismisses messages at this hour, so nothing is shown.');
  }

  let dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  await mkdir(dir, { recursive: true });
  const file = userFile(dir, user.id);

  return withLock(dir, async () => {
    const state = await load(file);
    const nowMs = t.getTime();
    const sent = state.sent.filter((s) => nowMs - s.t < SAME_KEY_MS);

    if (sent.some((s) => s.id === candidate.id)) return quiet('This message was already shown.');
    if (sent.some((s) => s.key === insight.key)) return quiet('The user already saw this finding recently.');
    if (sent.some((s) => Math.abs(nowMs - s.t) < MIN_GAP_MS)) return quiet('The user was messaged a short while ago, so this waits.');
    const today = sent.filter((s) => s.day === local.day).length;
    if (today >= MAX_PER_DAY) return quiet('The user already got a message today.');
    if (sent.filter((s) => nowMs - s.t < WEEK_MS).length >= MAX_PER_WEEK) return quiet('The user already got enough messages this week.');

    const pushOk = insight.confidence >= PUSH_CONFIDENCE && acted >= PUSH_MIN_ACTED && acted / total >= PUSH_MIN_ACT_SHARE;
    const surfaces = pushOk ? ['push', 'inApp'] : ['inApp'];

    sent.push({ t: nowMs, day: local.day, id: candidate.id, key: insight.key });
    await save(file, { sent });
    return { send: true, surfaces, reason: null };
  });
}
