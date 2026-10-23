// Broken B for Z6 (support and dry run). Standalone; the log and counters are kept in memory of the process.
// Mistakes: (1) the decision log lives in memory, so it is lost between processes and whyNotReceived in another process
// sees nothing, and the daily count is lost too; (2) availableAt is the next UTC midnight for every block, not the next
// local 08:00 or local midnight; (3) dryRun ignores consent.
// Direct failures: criterion 1 and 6 (log lost across processes), 2 (availableAt is UTC midnight), 4 (consent ignored
// in dryRun: the non-consenting user's event is counted as delivered).
// Cascade: 3 (no entries to read). Criterion 5 passes here by coincidence: the in-memory live run delivers n4 (the cap
// is lost between processes) and dryRun delivers n6 (consent ignored), so both sides come to 4 delivered and 2 blocked.
const CAP = 3;
const log = [];
const sent = new Map();
const fmt = new Map();
function parts(zone, date) {
  if (!fmt.has(zone)) fmt.set(zone, new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }));
  const p = {};
  for (const x of fmt.get(zone).formatToParts(date)) p[x.type] = x.value;
  return { day: `${p.year}-${p.month}-${p.day}`, minutes: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}
const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const inQuiet = (m, s, e) => (s > e ? m >= s || m < e : m >= s && m < e);
function utcMidnightAfter(now) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
}

export async function decide({ user, notification, now }) {
  const lp = parts(user.timezone, now);
  const key = `${user.id}|${lp.day}`;
  const used = sent.get(key) || 0;
  let rule = null;
  if (!user.consent) rule = "NO_CONSENT";
  else if (inQuiet(lp.minutes, 22 * 60, 8 * 60)) rule = "QUIET_HOURS";
  else if (used >= CAP) rule = "DAILY_CAP";
  const delivered = rule === null;
  if (delivered) sent.set(key, used + 1);
  const avail = rule === null || rule === "NO_CONSENT" ? null : utcMidnightAfter(now);
  const availHM = avail ? hm(parts(user.timezone, new Date(avail)).minutes) : null;
  const text = delivered
    ? `Sent at ${hm(lp.minutes)}.`
    : `Not sent at ${hm(lp.minutes)} (${rule})${availHM ? `; it can be sent from ${availHM}` : ""}.`;
  log.push({ notificationId: notification.id, at: now.toISOString(), delivered, ruleCode: rule, availableAt: avail, text, userId: user.id });
  return { send: delivered };
}

export async function whyNotReceived({ userId, from, to }) {
  return log
    .filter((e) => e.userId === userId && Date.parse(e.at) >= Date.parse(from) && Date.parse(e.at) < Date.parse(to))
    .map(({ userId: _u, ...rest }) => rest);
}

export async function dryRun({ events, policy }) {
  const q = policy && policy.quietHours;
  const toM = (s) => s.split(":").map(Number).reduce((a, b) => a * 60 + b);
  const counts = new Map();
  let delivered = 0;
  let blocked = 0;
  for (const e of [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    const lp = parts(e.user.timezone, new Date(e.at));
    const key = `${e.user.id}|${lp.day}`;
    const used = counts.get(key) || 0;
    const quiet = q && inQuiet(lp.minutes, toM(q.start), toM(q.end));
    if (quiet || (policy.dailyCap !== null && used >= policy.dailyCap)) blocked++;
    else {
      delivered++;
      counts.set(key, used + 1);
    }
  }
  return { delivered, blocked };
}
