// Broken B for Y3. Three plausible mistakes:
//   (1) the caller's events array is sorted in place, by time and then by id (so ties follow the id, not the input);
//   (2) held events count against the daily and weekly caps, as if they had been sent;
//   (3) the rule order is wrong: the caps are checked before consent, so a refused-for-consent event over the cap is
//       reported as dailyCap or weeklyCap.
// Expected to FAIL criteria 1 (counts differ when held events take cap room), 2 (input modified, tie order and
// held-counts effect), 6 (rule order) and possibly 3, 4 and 5 through the same held-counts effect.
// Standalone; clocks and weeks are correct, so the quiet-hours end times are right.

const MIN = 60000;

const fmtCache = new Map();
function local(ms, timeZone) {
  if (!fmtCache.has(timeZone)) {
    fmtCache.set(
      timeZone,
      new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }),
    );
  }
  const o = {};
  for (const p of fmtCache.get(timeZone).formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: Number(o.year), mo: Number(o.month), d: Number(o.day), min: (Number(o.hour) % 24) * 60 + Number(o.minute) };
}
const dayKey = (p) => `${p.y}-${p.mo}-${p.d}`;
function weekKey(p) {
  const dow = (new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay() + 6) % 7;
  return new Date(Date.UTC(p.y, p.mo - 1, p.d - dow)).toISOString().slice(0, 10);
}
const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
function inQuiet(minute, q) {
  if (!q) return false;
  const s = toMinutes(q.start);
  const e = toMinutes(q.end);
  return s < e ? minute >= s && minute < e : minute >= s || minute < e;
}
function quietEnd(ms, timeZone, endHHMM) {
  const target = toMinutes(endHHMM);
  for (let t = Math.floor(ms / MIN) * MIN + MIN, i = 0; i < 2880; i++, t += MIN) {
    if (local(t, timeZone).min === target) return t;
  }
  throw new Error("no end");
}

export function replay({ events, policy }) {
  // Mistake 1: sort the caller's array in place, ties by id.
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const daily = new Map();
  const weekly = new Map();
  const decisions = [];
  const counts = { sent: 0, held: 0, refused: 0 };
  const byRule = {};
  for (const ev of events) {
    const ms = Date.parse(ev.at);
    const p = local(ms, ev.timezone);
    const dk = `${ev.userId}|${dayKey(p)}`;
    const wk = `${ev.userId}|${weekKey(p)}`;
    let outcome = "sent";
    let rule = null;
    let holdUntil = null;
    // Mistake 3: caps are checked before consent and before quiet hours.
    if (policy.dailyCap != null && (daily.get(dk) || 0) >= policy.dailyCap) {
      outcome = "refused";
      rule = "dailyCap";
    } else if (policy.weeklyCap != null && (weekly.get(wk) || 0) >= policy.weeklyCap) {
      outcome = "refused";
      rule = "weeklyCap";
    } else if (policy.requireConsent && ev.consent !== true) {
      outcome = "refused";
      rule = "consent";
    } else if (ev.priority !== "critical" && inQuiet(p.min, policy.quietHours)) {
      outcome = "held";
      rule = "quietHours";
      holdUntil = new Date(quietEnd(ms, ev.timezone, policy.quietHours.end)).toISOString();
    }
    // Mistake 2: held events also take cap room.
    if (outcome === "sent" || outcome === "held") {
      daily.set(dk, (daily.get(dk) || 0) + 1);
      weekly.set(wk, (weekly.get(wk) || 0) + 1);
    }
    counts[outcome] += 1;
    if (rule !== null) byRule[rule] = (byRule[rule] || 0) + 1;
    decisions.push({ id: ev.id, outcome, rule, holdUntil });
  }
  return { decisions, counts, byRule };
}

const label = (d) => (d.outcome === "sent" ? "sent" : `${d.outcome}:${d.rule}`);

export function compare({ events, policyA, policyB }) {
  const a = replay({ events, policy: policyA });
  const b = replay({ events, policy: policyB });
  const changed = [];
  a.decisions.forEach((d, k) => {
    const from = label(d);
    const to = label(b.decisions[k]);
    if (from !== to) changed.push({ id: d.id, from, to });
  });
  return { countsA: a.counts, countsB: b.counts, byRuleA: a.byRule, byRuleB: b.byRule, changed };
}
