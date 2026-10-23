import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";

const MIN_CONFIDENCE = 0.6;
const MIN_DATA_POINTS = 5;
const MIN_ACCOUNT_AGE_DAYS = 3;
const QUIET_START_HOUR = 21; // local, inclusive
const QUIET_END_HOUR = 8; // local, exclusive
const MAX_PER_LOCAL_DAY = 2;
const MIN_GAP_MS = 4 * 3600 * 1000;
const SAME_KEY_COOLDOWN_MS = 14 * 24 * 3600 * 1000;
const HOUR_MIN_SAMPLES = 5;
const HOUR_MAX_DISMISS_RATIO = 0.7;
const PUSH_MIN_CONFIDENCE = 0.8;
const PUSH_MIN_HOUR_SAMPLES = 3;
const HISTORY_LIMIT = 200;

const quiet = (reason) => ({ send: false, surfaces: [], reason });

// Serialize state read-modify-write per user inside this process.
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return run;
}

function stateFile(userId) {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error("STATE_DIR is not set");
  return { dir, file: path.join(dir, `u_${encodeURIComponent(userId)}.json`) };
}

async function loadState(file) {
  try {
    const s = JSON.parse(await readFile(file, "utf8"));
    return { sent: Array.isArray(s.sent) ? s.sent : [] };
  } catch (e) {
    if (e.code === "ENOENT") return { sent: [] };
    throw e;
  }
}

async function saveState(dir, file, state) {
  await mkdir(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(state));
  await rename(tmp, file);
}

function localParts(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
    }).formatToParts(date);
    const get = (t) => parts.find((p) => p.type === t).value;
    return { day: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
  } catch {
    return null;
  }
}

const isNum = (x) => typeof x === "number" && Number.isFinite(x);

export async function decide({ user, candidate, context, now } = {}) {
  if (!user || typeof user.id !== "string" || user.id === "" || !candidate) {
    return quiet("Missing user or candidate data.");
  }
  const when = now instanceof Date ? now : new Date(now ?? Date.now());
  if (Number.isNaN(when.getTime())) return quiet("Invalid time.");

  // Hard stops that need no state.
  if (context?.crisis === true) return quiet("The user is in a crisis, so nothing is shown.");
  if (user.focusMode === true) return quiet("The user has focus mode on.");

  const insight = candidate.insight ?? {};
  if (!isNum(insight.confidence) || insight.confidence < MIN_CONFIDENCE) {
    return quiet("The finding is not confident enough to be worth showing.");
  }
  if (!isNum(insight.dataPoints) || insight.dataPoints < MIN_DATA_POINTS) {
    return quiet("The finding rests on too few observations.");
  }
  if (!isNum(user.accountAgeDays) || user.accountAgeDays < MIN_ACCOUNT_AGE_DAYS) {
    return quiet("The account is too new for proactive messages.");
  }

  const local = localParts(when, user.timezone);
  if (!local) return quiet("The user's timezone is unknown, so the local time is unclear.");
  if (local.hour >= QUIET_START_HOUR || local.hour < QUIET_END_HOUR) {
    return quiet("It is night for the user.");
  }

  const stats = context?.hourStats?.[String(local.hour)];
  const acted = isNum(stats?.acted) ? stats.acted : 0;
  const dismissed = isNum(stats?.dismissed) ? stats.dismissed : 0;
  const total = acted + dismissed;
  if (total >= HOUR_MIN_SAMPLES && dismissed / total > HOUR_MAX_DISMISS_RATIO) {
    return quiet("The user usually dismisses messages at this hour.");
  }

  const key = insight.key != null ? String(insight.key) : null;
  const t = when.getTime();

  return withLock(user.id, async () => {
    const { dir, file } = stateFile(user.id);
    const state = await loadState(file);
    const sent = state.sent;

    if (candidate.id != null && sent.some((s) => s.candidateId === String(candidate.id))) {
      return quiet("This message was already shown.");
    }
    if (key !== null && sent.some((s) => s.key === key && t - s.at < SAME_KEY_COOLDOWN_MS)) {
      return quiet("The user already saw this finding recently.");
    }
    const last = sent.reduce((m, s) => Math.max(m, s.at), -Infinity);
    if (t - last < MIN_GAP_MS && t >= last) {
      return quiet("Another message was shown a short time ago.");
    }
    const today = sent.filter((s) => localParts(new Date(s.at), user.timezone)?.day === local.day);
    if (today.length >= MAX_PER_LOCAL_DAY) {
      return quiet("The daily limit of messages is reached.");
    }

    const pushOk =
      insight.confidence >= PUSH_MIN_CONFIDENCE &&
      total >= PUSH_MIN_HOUR_SAMPLES &&
      acted >= dismissed;
    const surfaces = pushOk ? ["push", "inApp"] : ["inApp"];

    sent.push({ at: t, key, candidateId: candidate.id != null ? String(candidate.id) : null });
    state.sent = sent.slice(-HISTORY_LIMIT);
    await saveState(dir, file, state);
    return { send: true, surfaces, reason: null };
  });
}
