// Broken A for H5: ignores time zones. The cap day is the UTC calendar day (first 10 characters of `at`)
// and quiet hours are read on the UTC clock. Expected FAILS: 1 (counts), 2 (decisions), 3 (B and C counts/decisions),
// 5 (compare counts and changed list), and 6 (the 6b hold time: 08:00 UTC instead of 08:00 EDT).
// Expected PASSES: 4 (reasons and holdUntil shape only, which the mistake does not change) and the
// tie and cap rules of 6a and 6c, which do not depend on the zone.
// Standalone: node builtins only.
const MIN = 60000;
const utcMin = (ms) => Math.floor(ms / MIN) % 1440;
const toMin = (s) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
};
function inQuiet(min, q) {
  if (!q) return false;
  const s = toMin(q.start);
  const e = toMin(q.end);
  return s < e ? min >= s && min < e : min >= s || min < e;
}
function quietEnd(ms, q) {
  const target = toMin(q.end);
  let t = ms + MIN;
  while (utcMin(t) !== target) t += MIN;
  return t;
}

export function replay({ events, policy }) {
  const order = events
    .map((ev, pos) => ({ ev, pos }))
    .sort((a, b) => Date.parse(a.ev.at) - Date.parse(b.ev.at) || a.pos - b.pos)
    .map((x) => x.ev);
  const used = new Map();
  const decisions = [];
  const counts = { sent: 0, held: 0, refused: 0 };
  for (const ev of order) {
    const t = Date.parse(ev.at);
    let d;
    if (ev.priority !== "critical" && inQuiet(utcMin(t), policy.quietHours)) {
      d = { id: ev.id, outcome: "held", holdUntil: new Date(quietEnd(t, policy.quietHours)).toISOString(), reason: "Held because of quiet hours." };
    } else {
      const key = ev.userId + "|" + ev.at.slice(0, 10);
      const n = used.get(key) ?? 0;
      if (policy.dailyCap != null && n >= policy.dailyCap) {
        d = { id: ev.id, outcome: "refused", holdUntil: null, reason: "The daily cap for this user is already used up." };
      } else {
        used.set(key, n + 1);
        d = { id: ev.id, outcome: "sent", holdUntil: null, reason: null };
      }
    }
    counts[d.outcome] += 1;
    decisions.push(d);
  }
  return { decisions, counts };
}

export function compare({ events, policyA, policyB }) {
  const a = replay({ events, policy: policyA });
  const b = replay({ events, policy: policyB });
  const changed = [];
  a.decisions.forEach((d, k) => {
    if (b.decisions[k].outcome !== d.outcome) changed.push({ id: d.id, from: d.outcome, to: b.decisions[k].outcome });
  });
  return { countsA: a.counts, countsB: b.counts, changed };
}
