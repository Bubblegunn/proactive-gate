// Broken A for Y3. Two plausible mistakes:
//   (1) the local day, the ISO week and the quiet-hours clock are read in UTC instead of the event's zone, so a
//       New York event at 22:30 EDT is treated as 02:30 the next day, and the New York week for the 2026-03-08 DST
//       Sunday is cut at UTC midnight;
//   (2) byRule is not reported at all (replay returns no byRule, compare returns no byRuleA or byRuleB).
// Expected to FAIL criteria 1 (byRule missing), 2 (decisions wrong in quiet hours), 3 (B and C decisions wrong),
// 4 (New York week wrong) and 5 (byRule missing, changed differs). Criterion 6 uses the reference's rule order and
// the same clock mistake, so it may also fail.
// Standalone, pure, input not modified.

const MIN = 60000;

function utcParts(ms) {
  const d = new Date(ms);
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    min: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
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
function quietEnd(ms, endHHMM) {
  const target = toMinutes(endHHMM);
  for (let t = Math.floor(ms / MIN) * MIN + MIN, i = 0; i < 2880; i++, t += MIN) {
    if (utcParts(t).min === target) return t;
  }
  throw new Error("no end");
}

export function replay({ events, policy }) {
  const order = events
    .map((ev, index) => ({ ev, index, ms: Date.parse(ev.at) }))
    .sort((a, b) => a.ms - b.ms || a.index - b.index);
  const daily = new Map();
  const weekly = new Map();
  const decisions = [];
  const counts = { sent: 0, held: 0, refused: 0 };
  for (const { ev, ms } of order) {
    const p = utcParts(ms);
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
      holdUntil = new Date(quietEnd(ms, policy.quietHours.end)).toISOString();
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
    decisions.push({ id: ev.id, outcome, rule, holdUntil });
  }
  // Mistake 2: no byRule.
  return { decisions, counts };
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
  return { countsA: a.counts, countsB: b.counts, changed };
}
