import { promises as fs } from 'node:fs';
import path from 'node:path';

const HOUR = 3600e3;
const DAY = 24 * HOUR;

const CFG = {
  minConfidence: 0.7,
  minDataPoints: 5,
  minAccountAgeDays: 2,
  quietStart: 22, // local hour, inclusive
  quietEnd: 8, // local hour, exclusive
  minGapMs: 6 * HOUR, // between any two shown messages
  maxPerDay: 2,
  maxPerWeek: 5,
  sameKeyCooldownMs: 14 * DAY,
  minHourSamples: 4, // observations before hourStats is trusted
  minHourActRate: 0.25, // below this the hour is quiet
  pushMinActRate: 0.5,
  pushMinConfidence: 0.85,
  keepMs: 30 * DAY,
};

const quiet = (reason) => ({ send: false, surfaces: [], reason });

function localHour(now, timezone) {
  for (const tz of [timezone, 'UTC']) {
    try {
      const h = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour: 'numeric',
        hourCycle: 'h23',
      }).formatToParts(now).find((p) => p.type === 'hour').value;
      return Number(h) % 24;
    } catch {}
  }
  return now.getUTCHours();
}

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

const userFile = (dir, id) =>
  path.join(dir, `user-${encodeURIComponent(String(id)).replace(/%/g, '_')}-${Buffer.from(String(id)).toString('hex').slice(0, 64)}.json`);

async function readState(file) {
  try {
    const s = JSON.parse(await fs.readFile(file, 'utf8'));
    return {
      sent: Array.isArray(s.sent) ? s.sent : [],
    };
  } catch {
    return { sent: [] };
  }
}

async function writeState(file, state) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state));
  await fs.rename(tmp, file);
}

// Cross-process lock using atomic mkdir; stale locks are broken after 10 s.
async function withLock(file, fn) {
  const lock = `${file}.lock`;
  for (let i = 0; ; i++) {
    try {
      await fs.mkdir(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = await fs.stat(lock);
        if (Date.now() - st.mtimeMs > 10000) await fs.rmdir(lock);
      } catch {}
      if (i > 400) throw new Error('could not acquire state lock');
      await new Promise((r) => setTimeout(r, 10 + Math.random() * 20));
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rmdir(lock).catch(() => {});
  }
}

export async function decide({ user, candidate, context, now } = {}) {
  const t = now instanceof Date ? now : new Date(now ?? Date.now());
  if (!user || user.id == null || !candidate || !candidate.insight || Number.isNaN(t.getTime())) {
    return quiet('Input was incomplete, so nothing is shown.');
  }
  const { insight } = candidate;
  const ctx = context ?? {};

  // Stateless gates first (cheap, and nothing is recorded for them).
  if (ctx.crisis === true) return quiet('The user is in a crisis, so no proactive messages are shown.');
  if (user.focusMode === true) return quiet('The user has focus or do-not-disturb on.');

  const hour = localHour(t, user.timezone);
  if (hour >= CFG.quietStart || hour < CFG.quietEnd) {
    return quiet("It is night for the user, so nothing is shown.");
  }
  if (!(user.accountAgeDays >= CFG.minAccountAgeDays)) {
    return quiet('The account is too new to show proactive messages.');
  }
  const conf = Number(insight.confidence);
  const pts = Number(insight.dataPoints);
  if (!(conf >= CFG.minConfidence)) return quiet('The insight is not confident enough to be useful.');
  if (!(pts >= CFG.minDataPoints)) return quiet('The insight rests on too few observations.');

  const hs = ctx.hourStats?.[String(hour)];
  const acted = Number(hs?.acted) || 0;
  const dismissed = Number(hs?.dismissed) || 0;
  const total = acted + dismissed;
  const rate = total >= CFG.minHourSamples ? acted / total : null;
  if (rate !== null && rate < CFG.minHourActRate) {
    return quiet('The user usually dismisses messages at this hour.');
  }

  const dir = stateDir();
  await fs.mkdir(dir, { recursive: true });
  const file = userFile(dir, user.id);

  return withLock(file, async () => {
    const state = await readState(file);
    const ms = t.getTime();
    const sent = state.sent.filter((e) => ms - e.at < CFG.keepMs || e.at > ms);
    const past = sent.filter((e) => e.at <= ms);

    if (candidate.id != null && sent.some((e) => e.id === candidate.id)) {
      return quiet('This message was already shown.');
    }
    if (insight.key != null && past.some((e) => e.key === insight.key && ms - e.at < CFG.sameKeyCooldownMs)) {
      return quiet('The user already saw this finding recently.');
    }
    if (past.some((e) => ms - e.at < CFG.minGapMs)) {
      return quiet('A message was shown a short time ago.');
    }
    if (past.filter((e) => ms - e.at < DAY).length >= CFG.maxPerDay) {
      return quiet('The daily limit of proactive messages is reached.');
    }
    if (past.filter((e) => ms - e.at < 7 * DAY).length >= CFG.maxPerWeek) {
      return quiet('The weekly limit of proactive messages is reached.');
    }

    // In-app is the default; push only for strong insights at hours the user acts on.
    const surfaces = ['inApp'];
    if (rate !== null && rate >= CFG.pushMinActRate && conf >= CFG.pushMinConfidence) {
      surfaces.unshift('push');
    }

    sent.push({ at: ms, id: candidate.id ?? null, key: insight.key ?? null, surfaces });
    await writeState(file, { sent });
    return { send: true, surfaces, reason: null };
  });
}
