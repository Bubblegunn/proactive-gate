import { promises as fs } from "node:fs";
import path from "node:path";

const MIN_CONFIDENCE = 0.6;
const MIN_DATA_POINTS = 5;
const MIN_ACCOUNT_AGE_DAYS = 2;
const QUIET_START_HOUR = 22; // local, inclusive
const QUIET_END_HOUR = 8; // local, exclusive
const MAX_PER_DAY = 1;
const MAX_PER_WEEK = 3;
const MIN_GAP_MS = 6 * 3600 * 1000;
const REPEAT_WINDOW_MS = 30 * 24 * 3600 * 1000;
const MIN_HOUR_SAMPLES = 3;
const PUSH_MIN_ACT_RATE = 0.5;
const SKIP_MAX_ACT_RATE = 0.2; // below this (with enough samples) the hour is skipped
const DAY_MS = 24 * 3600 * 1000;

const quiet = (reason) => ({ send: false, surfaces: [], reason });

let queue = Promise.resolve();

function localParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return { hour: Number(p.hour), day: `${p.year}-${p.month}-${p.day}` };
}

async function readState(file) {
  try {
    const s = JSON.parse(await fs.readFile(file, "utf8"));
    return s && typeof s === "object" ? s : {};
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw e;
  }
}

async function writeState(file, state) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fh = await fs.open(tmp, "w");
  try {
    await fh.writeFile(JSON.stringify(state));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, file);
}

function evaluate({ user, candidate, context, now }, state) {
  if (context.crisis === true) return quiet("The user is in a crisis, so nothing is shown.");
  if (user.focusMode === true) return quiet("The user has focus mode on.");

  const insight = candidate?.insight;
  if (!insight || insight.key == null) return quiet("The candidate has no insight to show.");
  const conf = Number(insight.confidence);
  const points = Number(insight.dataPoints);
  if (!(conf >= MIN_CONFIDENCE)) return quiet("The insight is not confident enough.");
  if (!(points >= MIN_DATA_POINTS)) return quiet("The insight rests on too few observations.");
  if (!(Number(user.accountAgeDays) >= MIN_ACCOUNT_AGE_DAYS)) return quiet("The account is too new.");

  let local;
  try {
    local = localParts(now, user.timezone);
  } catch {
    return quiet("The user's timezone is unknown, so timing cannot be checked.");
  }
  if (local.hour >= QUIET_START_HOUR || local.hour < QUIET_END_HOUR) {
    return quiet("It is night for the user.");
  }

  const t = now.getTime();
  const rec = state[user.id] ?? { sent: [] };
  const sent = rec.sent.filter((s) => t - s.ts < 30 * DAY_MS);

  const key = String(insight.key);
  if (sent.some((s) => s.key === key && t - s.ts < REPEAT_WINDOW_MS)) {
    return quiet("The user already saw this finding.");
  }
  if (sent.some((s) => t - s.ts < MIN_GAP_MS && t >= s.ts)) {
    return quiet("A message was shown to the user recently.");
  }
  const today = sent.filter((s) => localParts(new Date(s.ts), user.timezone).day === local.day);
  if (today.length >= MAX_PER_DAY) return quiet("The user already got a message today.");
  if (sent.filter((s) => t - s.ts < 7 * DAY_MS).length >= MAX_PER_WEEK) {
    return quiet("The user already got enough messages this week.");
  }

  const stats = context.hourStats?.[String(local.hour)];
  const acted = Number(stats?.acted) || 0;
  const dismissed = Number(stats?.dismissed) || 0;
  const total = acted + dismissed;
  const rate = total > 0 ? acted / total : null;
  if (total >= MIN_HOUR_SAMPLES && rate < SKIP_MAX_ACT_RATE) {
    return quiet("The user usually dismisses messages at this hour.");
  }

  const surfaces = ["inApp"];
  if (total >= MIN_HOUR_SAMPLES && rate >= PUSH_MIN_ACT_RATE) surfaces.unshift("push");
  return { send: true, surfaces, reason: null, _key: key };
}

export async function decide(input) {
  const run = async () => {
    try {
      const { user, candidate, now } = input;
      const context = input.context ?? {};
      if (!user?.id || !(now instanceof Date) || Number.isNaN(now.getTime())) {
        return quiet("The request data is invalid.");
      }
      const dir = process.env.STATE_DIR;
      if (!dir) return quiet("No state directory is set, so repeats cannot be checked.");
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, "state.json");
      const state = await readState(file);
      const r = evaluate({ user, candidate, context, now }, state);
      if (!r.send) return r;
      const rec = state[user.id] ?? { sent: [] };
      rec.sent = [...rec.sent.filter((s) => now.getTime() - s.ts < 30 * DAY_MS), { ts: now.getTime(), key: r._key }];
      state[user.id] = rec;
      await writeState(file, state);
      return { send: true, surfaces: r.surfaces, reason: null };
    } catch {
      return quiet("The assistant could not check its records, so it stays quiet.");
    }
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}
