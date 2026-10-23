import { mkdir, readFile, writeFile, rename, rmdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const QUIET_START = 22; // local hour, inclusive
const QUIET_END = 8; // local hour, exclusive
const MIN_CONFIDENCE = 0.6;
const MIN_DATA_POINTS = 5;
const PUSH_CONFIDENCE = 0.85;
const MAX_PER_DAY = 2;
const MIN_GAP_MS = 4 * 3600 * 1000;
const REPEAT_WINDOW_MS = 14 * 24 * 3600 * 1000;
const KEEP_MS = 30 * 24 * 3600 * 1000;
const MIN_HOUR_SAMPLES = 3;

const quiet = (reason) => ({ send: false, surfaces: [], reason });

// Calls in one process run one at a time; a lock directory covers other processes.
let queue = Promise.resolve();

function localParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

function stateFile(user) {
  const dir = process.env.STATE_DIR;
  const name = createHash('sha256').update(String(user.id)).digest('hex').slice(0, 32);
  return { dir, file: path.join(dir, `${name}.json`), lock: path.join(dir, `${name}.lock`) };
}

async function withLock(lock, fn) {
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() > deadline) {
        // stale lock from a crashed process
        await rmdir(lock).catch(() => {});
        continue;
      }
      await new Promise((r) => setTimeout(r, 10));
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
    const data = JSON.parse(await readFile(file, 'utf8'));
    return Array.isArray(data.sent) ? data.sent : [];
  } catch {
    return [];
  }
}

async function save(file, sent) {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ sent }));
  await rename(tmp, file);
}

function valid(user, candidate, now) {
  return (
    user && user.id != null && candidate && candidate.insight &&
    candidate.insight.key != null &&
    now instanceof Date && !Number.isNaN(now.getTime())
  );
}

async function run({ user, candidate, context, now }) {
  if (!valid(user, candidate, now)) return quiet('The request was incomplete, so nothing is shown.');
  if (!process.env.STATE_DIR) return quiet('No place to keep history, so nothing is shown.');

  if (context?.crisis === true) return quiet('The user is in a crisis, so no proactive message is shown.');
  if (user.focusMode === true) return quiet('The user turned on focus mode, so nothing is shown.');

  let local;
  try {
    local = localParts(now, user.timezone);
  } catch {
    return quiet('The local time is unknown, so nothing is shown.');
  }
  if (local.hour >= QUIET_START || local.hour < QUIET_END) {
    return quiet('It is night for the user, so nothing is shown.');
  }

  const { confidence, dataPoints, key } = candidate.insight;
  if (!(typeof confidence === 'number') || confidence < MIN_CONFIDENCE) {
    return quiet('The finding is not certain enough to be useful.');
  }
  if (!(typeof dataPoints === 'number') || dataPoints < MIN_DATA_POINTS) {
    return quiet('The finding rests on too few observations.');
  }

  const stats = context?.hourStats?.[String(local.hour)];
  const acted = Number(stats?.acted) || 0;
  const dismissed = Number(stats?.dismissed) || 0;
  const samples = acted + dismissed;
  if (samples >= MIN_HOUR_SAMPLES && acted / samples < 0.25) {
    return quiet('The user usually dismisses messages at this hour.');
  }

  const { dir, file, lock } = stateFile(user);
  await mkdir(dir, { recursive: true });

  return withLock(lock, async () => {
    const nowMs = now.getTime();
    const sent = (await load(file)).filter((s) => nowMs - s.at < KEEP_MS);

    const repeat = sent.some(
      (s) => (s.key === String(key) || s.id === candidate.id) && Math.abs(nowMs - s.at) < REPEAT_WINDOW_MS,
    );
    if (repeat) return quiet('The user already saw this finding recently.');

    const last = sent.reduce((m, s) => Math.max(m, s.at), -Infinity);
    if (nowMs >= last && nowMs - last < MIN_GAP_MS) {
      return quiet('A message was shown a short time ago, so this one waits.');
    }
    const today = sent.filter((s) => {
      try {
        return localParts(new Date(s.at), user.timezone).day === local.day;
      } catch {
        return false;
      }
    });
    if (today.length >= MAX_PER_DAY) return quiet('The daily limit of messages is reached.');

    const surfaces = ['inApp'];
    if (confidence >= PUSH_CONFIDENCE && samples >= MIN_HOUR_SAMPLES && acted / samples >= 0.5) {
      surfaces.unshift('push');
    }

    sent.push({ key: String(key), id: candidate.id ?? null, at: nowMs });
    await save(file, sent);
    return { send: true, surfaces, reason: null };
  });
}

export async function decide(input) {
  const result = queue.then(() => run(input || {}));
  queue = result.catch(() => {});
  try {
    return await result;
  } catch {
    return quiet('Something went wrong, so nothing is shown.');
  }
}
