// Broken B for H5: two mistakes. (1) It sorts the caller's array in place (events.sort), so the input is modified.
// (2) It breaks ties by id instead of input order, and it counts held events against the daily cap.
// Expected FAILS: 2 (input array modified), 1, 3 and 5 (held events use up the cap, so counts change),
// 6 (6c: ids t1 and t2 always put t1 first, so the swapped input is wrong).
// Expected PASSES: 4 (reasons and holdUntil shape are right) and 6a and 6b, which have no ties.
// Standalone: node builtins only.
const MIN = 60000;
const fmts = new Map();
function local(ms, tz) {
  if (!fmts.has(tz)) {
    fmts.set(tz, new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }));
  }
  const p = {};
  for (const x of fmts.get(tz).formatToParts(new Date(ms))) p[x.type] = x.value;
  return { day: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute) };
}
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
function quietEnd(ms, tz, q) {
  const target = toMin(q.end);
  let t = ms;
  for (;;) {
    t += MIN;
    if (local(t, tz).min === target) return t;
  }
}

export function replay({ events, policy }) {
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const used = new Map();
  const decisions = [];
  const counts = { sent: 0, held: 0, refused: 0 };
  for (const ev of events) {
    const t = Date.parse(ev.at);
    const day = local(t, ev.timezone).day;
    const key = ev.userId + "|" + day;
    let d;
    if (ev.priority !== "critical" && inQuiet(local(t, ev.timezone).min, policy.quietHours)) {
      used.set(key, (used.get(key) ?? 0) + 1); // mistake: held events count against the cap
      d = { id: ev.id, outcome: "held", holdUntil: new Date(quietEnd(t, ev.timezone, policy.quietHours)).toISOString(), reason: "Held because of quiet hours." };
    } else {
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
