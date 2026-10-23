import { promises as fs } from "node:fs";
import path from "node:path";

const DAY_MS = 24 * 3600 * 1000;
const KEY_WINDOW_MS = 30 * DAY_MS; // same finding is not shown again within 30 days
const MIN_GAP_MS = 4 * 3600 * 1000; // minimum time between two shown messages
const MAX_PER_DAY = 2; // per user, per local calendar day
const MIN_ACCOUNT_AGE_DAYS = 3;
const MIN_DATA_POINTS = 5;
const MIN_CONFIDENCE = 0.6;
const PUSH_MIN_DATA_POINTS = 10;
const PUSH_MIN_CONFIDENCE = 0.8;
const QUIET_START = 22; // local hours [22, 8) allow no push
const QUIET_END = 8;
const HOUR_MIN_SAMPLES = 5;
const HOUR_MAX_DISMISS_RATE = 0.6;

const no = (reason) => ({ send: false, surfaces: [], reason });

function localParts(date, timezone) {
  const make = (tz) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
    });
  let fmt;
  try {
    fmt = make(timezone || "UTC");
  } catch {
    fmt = make("UTC");
  }
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}

function stateFile() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error("STATE_DIR is not set");
  return { dir, file: path.join(dir, "gate-state.json") };
}

async function load(file) {
  try {
    const data = JSON.parse(await fs.readFile(file, "utf8"));
    if (data && typeof data.users === "object" && data.users) return data;
  } catch {}
  return { users: {} };
}

async function save(dir, file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data));
  await fs.rename(tmp, file);
}

// Calls run one at a time so concurrent decisions cannot both pass the caps.
let queue = Promise.resolve();

export function decide(input) {
  const run = queue.then(() => decideNow(input));
  queue = run.catch(() => {});
  return run;
}

async function decideNow({ user, candidate, context, now } = {}) {
  const insight = candidate?.insight;
  if (!user?.id || !candidate || !insight || insight.key == null) {
    return no("The request is missing required data, so nothing is shown.");
  }
  const when = now instanceof Date && !isNaN(now) ? now : new Date();
  const t = when.getTime();

  if (context?.crisis === true) return no("The user is in a crisis, so no proactive message is shown.");
  if (user.focusMode === true) return no("The user has focus mode on, so nothing is shown.");

  if (typeof user.accountAgeDays === "number" && user.accountAgeDays < MIN_ACCOUNT_AGE_DAYS) {
    return no("The account is too new for proactive messages.");
  }

  const dp = Number(insight.dataPoints);
  const conf = Number(insight.confidence);
  if (!(dp >= MIN_DATA_POINTS)) return no("The finding rests on too few observations.");
  if (!(conf >= MIN_CONFIDENCE)) return no("The finding is not confident enough to be useful.");

  const { day, hour } = localParts(when, user.timezone);
  const stats = context?.hourStats?.[String(hour)];
  const acted = Number(stats?.acted) || 0;
  const dismissed = Number(stats?.dismissed) || 0;
  const total = acted + dismissed;
  const badHour = total >= HOUR_MIN_SAMPLES && dismissed / total > HOUR_MAX_DISMISS_RATE;

  const { dir, file } = stateFile();
  await fs.mkdir(dir, { recursive: true });
  const state = await load(file);
  const entry = state.users[user.id] || { sent: [] };
  entry.sent = (entry.sent || []).filter((s) => t - s.t < KEY_WINDOW_MS && s.t <= t + DAY_MS);

  const key = String(insight.key);
  if (entry.sent.some((s) => s.key === key)) {
    return no("The user already saw this finding recently.");
  }
  const last = entry.sent.reduce((m, s) => Math.max(m, s.t), 0);
  if (last && t - last < MIN_GAP_MS) return no("A message was shown a short time ago.");
  const today = entry.sent.filter((s) => localParts(new Date(s.t), user.timezone).day === day).length;
  if (today >= MAX_PER_DAY) return no("The daily limit of proactive messages is reached.");

  const surfaces = ["inApp"];
  const quiet = hour >= QUIET_START || hour < QUIET_END;
  if (!quiet && !badHour && conf >= PUSH_MIN_CONFIDENCE && dp >= PUSH_MIN_DATA_POINTS) {
    surfaces.unshift("push");
  }

  entry.sent.push({ t, key, type: candidate.type ?? null, id: candidate.id ?? null });
  state.users[user.id] = entry;
  await save(dir, file, state);
  return { send: true, surfaces, reason: null };
}
