// Broken B for H2: the counts live in one JSON file that is read, judged and written back with no lock.
// Refused calls are recorded too, so they count toward every cap. Expected FAILS: 4 (refused calls fill the
// month early, so Tue 8 cannot send its twelfth message), 6 (overlapping calls read the file before any of
// them writes, so more than three per user are sent; refused calls also count). Expected PASSES: 1, 2, 3 and 5,
// which are sequential runs where the race does not occur and the counts still stay within the caps.
// Calendar windows and hold times are the same as the good reference. Standalone: node builtins only.
import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const LIMITS = { daily: 3, weekly: 7, monthly: 12 };
const fmts = new Map();

function wallMs(ms, tz) {
  if (!fmts.has(tz)) {
    fmts.set(tz, new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", second: "numeric",
    }));
  }
  const p = {};
  for (const x of fmts.get(tz).formatToParts(new Date(ms))) p[x.type] = Number(x.value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

const offset = (ms, tz) => wallMs(ms, tz) - Math.floor(ms / 1000) * 1000;

function localMidnight(y, mo, d, tz) {
  const target = Date.UTC(y, mo - 1, d);
  let t = target;
  for (let i = 0; i < 2; i++) t = target - offset(t, tz);
  return t;
}

function windows(ms, tz) {
  const w = new Date(wallMs(ms, tz));
  const y = w.getUTCFullYear();
  const mo = w.getUTCMonth() + 1;
  const d = w.getUTCDate();
  const back = (w.getUTCDay() + 6) % 7;
  return {
    daily: [localMidnight(y, mo, d, tz), localMidnight(y, mo, d + 1, tz)],
    weekly: [localMidnight(y, mo, d - back, tz), localMidnight(y, mo, d - back + 7, tz)],
    monthly: [localMidnight(y, mo, 1, tz), localMidnight(y, mo + 1, 1, tz)],
  };
}

async function loadState(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return { sends: [] };
  }
}

export async function trySend({ user, message, now }) {
  const dir = process.env.STATE_DIR;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "caps.json");
  const state = await loadState(file); // read ...
  const ms = now.getTime();
  const win = windows(ms, user.timezone);
  const n = (k) => state.sends.filter((s) => s.user === user.id && s.at >= win[k][0] && s.at < win[k][1]).length;
  const full = Object.keys(LIMITS).filter((k) => n(k) >= LIMITS[k]);
  state.sends.push({ user: user.id, at: ms }); // mistake: every call is recorded, refused ones too
  await writeFile(file, JSON.stringify(state)); // ... then write, with no lock in between
  if (full.length === 0) return { sent: true, holdUntil: null, reason: null };
  const hold = Math.max(...full.map((k) => win[k][1]));
  const names = full.map((k) => `the ${k} cap`).join(" and ");
  return {
    sent: false,
    holdUntil: new Date(hold).toISOString(),
    reason: `Not sent: ${names} ${full.length === 1 ? "is" : "are"} full.`,
  };
}
