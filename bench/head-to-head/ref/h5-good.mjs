// Reference for H5 replay and compare. Standalone: node builtins only.
// Local clocks come from Intl; a hold ends at the first minute after the event whose local clock reads the quiet end.
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
  for (let i = 0; i < 3 * 24 * 60; i++) {
    t += MIN;
    if (local(t, tz).min === target) return t;
  }
  return null;
}

export function replay({ events, policy }) {
  // Work on a copy so the caller's array keeps its order.
  const order = events
    .map((ev, pos) => ({ ev, pos, t: Date.parse(ev.at) }))
    .sort((a, b) => a.t - b.t || a.pos - b.pos);

  const used = new Map();
  const decisions = [];
  const counts = { sent: 0, held: 0, refused: 0 };
  for (const { ev, t } of order) {
    let d;
    if (ev.priority !== "critical" && inQuiet(local(t, ev.timezone).min, policy.quietHours)) {
      d = {
        id: ev.id,
        outcome: "held",
        holdUntil: new Date(quietEnd(t, ev.timezone, policy.quietHours)).toISOString(),
        reason: "Held because of quiet hours until the end of the window.",
      };
    } else {
      const key = ev.userId + "|" + local(t, ev.timezone).day;
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
    const to = b.decisions[k].outcome;
    if (to !== d.outcome) changed.push({ id: d.id, from: d.outcome, to });
  });
  return { countsA: a.counts, countsB: b.counts, changed };
}
