import { promises as fs } from 'node:fs';
import path from 'node:path';

const MIN_DATA_POINTS = 3;
const MIN_CONFIDENCE = 0.6;
const REPEAT_WINDOW_MS = 14 * 24 * 3600 * 1000; // same finding is not shown again within 14 days
const DAILY_CAP = 3; // max delivered messages per user in any 24 hours
const QUIET_START = 22; // local hour, inclusive: no push from 22:00
const QUIET_END = 8; // local hour, exclusive: no push before 08:00
const MIN_HOUR_SAMPLES = 5;
const MAX_DISMISS_RATE = 0.7;
const KEEP_MS = 30 * 24 * 3600 * 1000;

const quiet = (reason) => ({ send: false, surfaces: [], reason });

function localHour(now, timezone) {
  for (const tz of [timezone, 'UTC']) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hour: 'numeric', hourCycle: 'h23',
      }).formatToParts(now);
      const h = Number(parts.find((p) => p.type === 'hour').value);
      if (Number.isInteger(h)) return h % 24;
    } catch { /* try next */ }
  }
  return now.getUTCHours();
}

// ---- state: one JSON file, atomic writes, cross-process lock ----
const stateDir = () => {
  const d = process.env.STATE_DIR;
  if (!d) throw new Error('STATE_DIR is not set');
  return d;
};

async function withLock(dir, fn) {
  const lock = path.join(dir, '.lock');
  const deadline = Date.now() + 10000;
  for (;;) {
    try { await fs.mkdir(lock); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = await fs.stat(lock);
        if (Date.now() - st.mtimeMs > 5000) { await fs.rmdir(lock).catch(() => {}); continue; }
      } catch { continue; }
      if (Date.now() > deadline) throw new Error('state lock timeout');
      await new Promise((r) => setTimeout(r, 10 + Math.random() * 20));
    }
  }
  try { return await fn(); } finally { await fs.rmdir(lock).catch(() => {}); }
}

async function load(file) {
  try {
    const s = JSON.parse(await fs.readFile(file, 'utf8'));
    if (s && typeof s === 'object' && s.users && typeof s.users === 'object') return s;
  } catch { /* missing or corrupt: start fresh */ }
  return { users: {} };
}

async function save(file, state) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const fh = await fs.open(tmp, 'w');
  try { await fh.writeFile(JSON.stringify(state)); await fh.sync(); } finally { await fh.close(); }
  await fs.rename(tmp, file);
}

let queue = Promise.resolve();

export function decide(input) {
  const run = queue.then(() => evaluate(input));
  queue = run.catch(() => {});
  return run;
}

async function evaluate({ user, candidate, context, now } = {}) {
  const at = now instanceof Date && !isNaN(now) ? now : new Date(now ?? Date.now());
  if (isNaN(at)) return quiet('The time is not valid, so nothing is shown.');
  if (!user || !candidate) return quiet('Missing user or candidate data, so nothing is shown.');

  // Rules that need no state.
  if (context?.crisis === true) return quiet('The user may be in a crisis, so no proactive message is shown.');
  if (user.focusMode === true) return quiet('The user turned on focus mode, so nothing is shown.');

  const insight = candidate.insight ?? {};
  const dataPoints = Number(insight.dataPoints);
  const confidence = Number(insight.confidence);
  if (!(dataPoints >= MIN_DATA_POINTS)) return quiet('The finding rests on too few observations.');
  if (!(confidence >= MIN_CONFIDENCE)) return quiet('The finding is not confident enough to show.');

  const hour = localHour(at, user.timezone);
  const stats = context?.hourStats?.[String(hour)];
  if (stats) {
    const acted = Number(stats.acted) || 0;
    const dismissed = Number(stats.dismissed) || 0;
    const total = acted + dismissed;
    if (total >= MIN_HOUR_SAMPLES && dismissed / total > MAX_DISMISS_RATE) {
      return quiet('The user usually dismisses messages at this hour.');
    }
  }
  const isQuietHours = hour >= QUIET_START || hour < QUIET_END;

  // Rules that need history. Check and record under one lock.
  const dir = stateDir();
  await fs.mkdir(dir, { recursive: true });
  return withLock(dir, async () => {
    const file = path.join(dir, 'state.json');
    const state = await load(file);
    const t = at.getTime();
    const uid = String(user.id);
    const hist = (state.users[uid] ?? []).filter((h) => t - h.at < KEEP_MS || h.at > t);

    const key = String(insight.key ?? candidate.id);
    if (hist.some((h) => h.key === key && Math.abs(t - h.at) < REPEAT_WINDOW_MS)) {
      return quiet('The user already saw this finding recently.');
    }
    if (candidate.id != null && hist.some((h) => h.id === candidate.id)) {
      return quiet('This message was already shown.');
    }
    const last24h = hist.filter((h) => h.at <= t && t - h.at < 24 * 3600 * 1000).length;
    if (last24h >= DAILY_CAP) return quiet('The daily limit of proactive messages is reached.');

    hist.push({ key, id: candidate.id ?? null, at: t });
    state.users[uid] = hist;
    await save(file, state);
    return { send: true, surfaces: isQuietHours ? ['inApp'] : ['push', 'inApp'], reason: null };
  });
}
