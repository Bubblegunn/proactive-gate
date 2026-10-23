import fs from 'node:fs/promises';
import path from 'node:path';

const DAY = 24 * 3600e3;
const CFG = {
  minAccountAgeDays: 2,
  minDataPoints: 5,
  minConfidence: 0.6,
  pushConfidence: 0.8,
  quietStart: 22, // local hour, inclusive
  quietEnd: 8, // local hour, exclusive
  minGapMs: 4 * 3600e3,
  maxPer24h: 2,
  sameKeyCooldownMs: 7 * DAY,
  hourMinSamples: 5,
  hourDismissRatio: 0.7,
  retainMs: 30 * DAY,
};

const no = (reason) => ({ send: false, surfaces: [], reason });

function localHour(now, timezone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hourCycle: 'h23' }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === 'hour')?.value);
    return Number.isInteger(h) && h >= 0 && h <= 23 ? h : null;
  } catch {
    return null;
  }
}

const isQuiet = (h) => (CFG.quietStart > CFG.quietEnd ? h >= CFG.quietStart || h < CFG.quietEnd : h >= CFG.quietStart && h < CFG.quietEnd);

// ---- state (per user, JSON file, atomic write, lock for cross-process safety) ----
function stateDir() {
  const d = process.env.STATE_DIR;
  if (!d) throw new Error('STATE_DIR is not set');
  return d;
}
const fileFor = (userId) => path.join(stateDir(), `user-${encodeURIComponent(String(userId))}.json`);

async function readState(file) {
  try {
    const s = JSON.parse(await fs.readFile(file, 'utf8'));
    return Array.isArray(s.delivered) ? s : { delivered: [] };
  } catch {
    return { delivered: [] };
  }
}

async function writeState(file, state) {
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

async function withLock(file, fn) {
  const lock = `${file}.lock`;
  const start = Date.now();
  for (;;) {
    try {
      await fs.mkdir(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = await fs.stat(lock);
        if (Date.now() - st.mtimeMs > 10000) await fs.rmdir(lock).catch(() => {});
      } catch {}
      if (Date.now() - start > 15000) throw new Error('lock timeout');
      await new Promise((r) => setTimeout(r, 10 + Math.random() * 20));
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rmdir(lock).catch(() => {});
  }
}

// serialize calls within this process too
let chain = Promise.resolve();

function evaluate({ user, candidate, context, now }, state) {
  if (!user || user.id == null || !candidate || !candidate.insight) return { verdict: no('Input is incomplete, so nothing is shown.') };
  const ts = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(ts)) return { verdict: no('The current time is unknown, so nothing is shown.') };

  if (context?.crisis === true) return { verdict: no('The user is in a crisis, so no proactive message is shown.') };
  if (user.focusMode === true) return { verdict: no('The user has focus or do-not-disturb on.') };

  const hour = localHour(new Date(ts), user.timezone);
  if (hour === null) return { verdict: no("The user's local time is unknown, so nothing is shown.") };
  if (isQuiet(hour)) return { verdict: no('It is night for the user, so nothing is shown.') };

  if (!(user.accountAgeDays >= CFG.minAccountAgeDays)) return { verdict: no('The account is too new for proactive messages.') };

  const { key, dataPoints, confidence } = candidate.insight;
  if (!(dataPoints >= CFG.minDataPoints)) return { verdict: no('Too few observations back this insight.') };
  if (!(confidence >= CFG.minConfidence)) return { verdict: no('Confidence in this insight is too low.') };

  const recent = state.delivered.filter((d) => ts - d.ts < CFG.retainMs);
  if (candidate.id != null && recent.some((d) => d.id === candidate.id)) return { verdict: no('This message was already shown.') };
  if (key != null && recent.some((d) => d.key === key && ts - d.ts < CFG.sameKeyCooldownMs)) return { verdict: no('The user already saw this finding recently.') };
  const last = recent.reduce((m, d) => Math.max(m, d.ts), -Infinity);
  if (ts - last < CFG.minGapMs && ts >= last) return { verdict: no('A message was shown a short while ago.') };
  if (recent.filter((d) => ts - d.ts < DAY).length >= CFG.maxPer24h) return { verdict: no('The daily limit of proactive messages is reached.') };

  const hs = context?.hourStats?.[String(hour)];
  const acted = Number(hs?.acted) || 0;
  const dismissed = Number(hs?.dismissed) || 0;
  const total = acted + dismissed;
  if (total >= CFG.hourMinSamples && dismissed / total >= CFG.hourDismissRatio) {
    return { verdict: no('The user usually dismisses messages at this hour.') };
  }

  const pushOk = confidence >= CFG.pushConfidence && (total < CFG.hourMinSamples || acted >= dismissed);
  const surfaces = pushOk ? ['push', 'inApp'] : ['inApp'];
  return { verdict: { send: true, surfaces, reason: null }, record: { id: candidate.id ?? null, key: key ?? null, ts, surfaces } };
}

export async function decide(input) {
  const run = async () => {
    const userId = input?.user?.id;
    if (userId == null) return evaluate(input ?? {}, { delivered: [] }).verdict;
    await fs.mkdir(stateDir(), { recursive: true });
    const file = fileFor(userId);
    return withLock(file, async () => {
      const state = await readState(file);
      const { verdict, record } = evaluate(input, state);
      if (record) {
        state.delivered = state.delivered.filter((d) => record.ts - d.ts < CFG.retainMs);
        state.delivered.push(record);
        await writeState(file, state);
      }
      return verdict;
    });
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}
