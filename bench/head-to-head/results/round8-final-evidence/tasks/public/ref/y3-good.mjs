// Reference for Y3: replay({ events, policy }) and compare({ events, policyA, policyB }). Standalone, node builtins
// only. Pure: no network, no files, the input array is never modified.
//
// Processing order: time, ties by input position. Rule order: consent, quiet hours (not for critical), daily cap,
// weekly cap; the first that applies decides. Held and refused events count for nothing. Local days and clocks come
// from Intl.DateTimeFormat in the user's zone; the ISO week is keyed by its local Monday.

const fmtCache = new Map();
function local(ms, timeZone) {
  if (!fmtCache.has(timeZone)) {
    fmtCache.set(
      timeZone,
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
      }),
    );
  }
  const o = {};
  for (const p of fmtCache.get(timeZone).formatToParts(new Date(ms))) o[p.type] = p.value;
  const y = Number(o.year);
  const mo = Number(o.month);
  const d = Number(o.day);
  return { y, mo, d, min: (Number(o.hour) % 24) * 60 + Number(o.minute) };
}

// Monday (as YYYY-MM-DD) of the ISO week that holds the local calendar date.
function weekKey(p) {
  const dow = (new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay() + 6) % 7;
  return new Date(Date.UTC(p.y, p.mo - 1, p.d - dow)).toISOString().slice(0, 10);
}
const dayKey = (p) => `${p.y}-${p.mo}-${p.d}`;

const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
function inQuiet(minute, quietHours) {
  if (quietHours === null || quietHours === undefined) return false;
  const start = toMinutes(quietHours.start);
  const end = toMinutes(quietHours.end);
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

// The instant at which quiet hours end: the first moment after ms whose local clock reads the end time.
function quietEnd(ms, timeZone, endHHMM) {
  const target = toMinutes(endHHMM);
  for (let t = Math.floor(ms / 60000) * 60000 + 60000, i = 0; i < 2880; i++, t += 60000) {
    const p = local(t, timeZone);
    if (p.min === target) return t;
  }
  throw new Error(`no end of quiet hours found after ${ms}`);
}

export function replay({ events, policy }) {
  // A sorted copy: the caller's array is left as it was.
  const order = events
    .map((ev, index) => ({ ev, index, ms: Date.parse(ev.at) }))
    .sort((a, b) => a.ms - b.ms || a.index - b.index);

  const daily = new Map();
  const weekly = new Map();
  const decisions = [];
  const counts = { sent: 0, held: 0, refused: 0 };
  const byRule = {};

  for (const { ev, ms } of order) {
    const p = local(ms, ev.timezone);
    const dk = `${ev.userId}|${dayKey(p)}`;
    const wk = `${ev.userId}|${weekKey(p)}`;

    let outcome = "sent";
    let rule = null;
    let holdUntil = null;

    if (policy.requireConsent && ev.consent !== true) {
      outcome = "refused";
      rule = "consent";
    } else if (ev.priority !== "critical" && inQuiet(p.min, policy.quietHours)) {
      outcome = "held";
      rule = "quietHours";
      holdUntil = new Date(quietEnd(ms, ev.timezone, policy.quietHours.end)).toISOString();
    } else if (policy.dailyCap != null && (daily.get(dk) || 0) >= policy.dailyCap) {
      outcome = "refused";
      rule = "dailyCap";
    } else if (policy.weeklyCap != null && (weekly.get(wk) || 0) >= policy.weeklyCap) {
      outcome = "refused";
      rule = "weeklyCap";
    }

    if (outcome === "sent") {
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
  // Both replays list the same events in the same processing order, so positions line up.
  const changed = [];
  a.decisions.forEach((d, k) => {
    const from = label(d);
    const to = label(b.decisions[k]);
    if (from !== to) changed.push({ id: d.id, from, to });
  });
  return {
    countsA: a.counts,
    countsB: b.counts,
    byRuleA: a.byRule,
    byRuleB: b.byRule,
    changed,
  };
}
