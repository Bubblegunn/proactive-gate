const fmts = new Map();
function localMinutes(ms, tz) {
  let f = fmts.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }); fmts.set(tz, f); }
  let h = 0, m = 0;
  for (const p of f.formatToParts(new Date(ms))) { if (p.type === 'hour') h = +p.value; if (p.type === 'minute') m = +p.value; }
  return h * 60 + m;
}
const hhmm = min => String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
const toMin = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const inQuiet = (min, q) => { const s = toMin(q.start), e = toMin(q.end); return s <= e ? (min >= s && min < e) : (min >= s || min < e); };
const DAY = 86400000;
const cmp = (a, b) => (a.t - b.t) || (a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0);

function reasonsFor(c, t, u, policy, areaCodes, hist) {
  const out = [];
  if (u.optedOut === true) out.push({ code: 'opted_out', detail: 'recipient opted out of all messages' });
  if (u.consent?.[c.channel] !== true) out.push({ code: 'no_consent', detail: `no consent recorded for channel ${c.channel}` });
  if (u.snoozedUntil && t < Date.parse(u.snoozedUntil)) out.push({ code: 'snoozed', detail: `snoozed until ${u.snoozedUntil}` });
  const quiet = u.quiet === undefined ? policy.quietDefault : u.quiet; // MARK_QUIETDEFAULT
  if (c.priority !== 'critical' && quiet) {
    const m = localMinutes(t, u.tz);
    if (inQuiet(m, quiet)) out.push({ code: 'quiet_hours', detail: `${hhmm(m)} in ${u.tz} is inside quiet hours ${quiet.start}-${quiet.end}` });
  }
  if (c.channel === 'sms' && typeof u.phone === 'string' && u.phone.startsWith('+1')) {
    const pairs = [{ tz: u.tz, state: u.state }];
    const ac = areaCodes[u.phone.slice(2, 5)];
    if (ac) pairs.push({ tz: ac.tz, state: ac.state });
    const bad = [];
    for (const p of pairs) {
      const w = (p.state && policy.legal[p.state]) || policy.legal.default;
      const m = localMinutes(t, p.tz);
      if (m < toMin(w.start) || m >= toMin(w.end)) bad.push(`${hhmm(m)} in ${p.tz} is outside the ${p.state || 'default'} contact window ${w.start}-${w.end}`);
    }
    if (bad.length) out.push({ code: 'legal_window', detail: bad.join('; ') });
  }
  const mine = hist.filter(h => h.userId === u.id);
  const n24 = mine.filter(h => h.t <= t && h.t > t - DAY), n7 = mine.filter(h => h.t <= t && h.t > t - 7 * DAY);
  const l24 = policy.caps.rolling24h, l7 = policy.caps.rolling7d, lc = policy.caps.channel24h?.[c.channel];
  if (l24 != null && n24.length >= l24) out.push({ code: 'rolling_24h_cap', detail: `${n24.length} messages sent in the last 24 hours, limit ${l24}` });
  if (l7 != null && n7.length >= l7) out.push({ code: 'rolling_7d_cap', detail: `${n7.length} messages sent in the last 7 days, limit ${l7}` });
  if (lc != null) { const nc = n24.filter(h => h.channel === c.channel).length; if (nc >= lc) out.push({ code: 'channel_24h_cap', detail: `${nc} ${c.channel} messages sent in the last 24 hours, limit ${lc}` }); }
  return out;
}

function runPolicy(policy, list, events, history0, users, areaCodes) {
  const hist = history0.filter(h => h.status === 'sent').map(h => ({ userId: h.userId, channel: h.channel, t: Date.parse(h.at) }));
  const state = new Map();
  const get = id => { let s = state.get(id); if (!s) { const u = users.get(id); s = { ...u, consent: { ...(u.consent || {}) } }; state.set(id, s); } return s; };
  const ev = events.map((e, i) => ({ e, t: Date.parse(e.at), i })).sort((a, b) => (a.t - b.t) || (a.i - b.i));
  let k = 0;
  const out = new Map();
  for (const { c, t } of list) {
    while (k < ev.length && ev[k].t <= t) {
      const e = ev[k++].e;
      if (!users.has(e.userId)) continue;
      const s = get(e.userId);
      if (e.type === 'stop') s.consent.sms = false;
      else if (e.type === 'start') s.consent.sms = true;
      else if (e.type === 'snooze') s.snoozedUntil = e.until ?? null;
      else if (e.type === 'optout') s.optedOut = true;
    }
    if (!users.has(c.userId)) { out.set(c.id, { outcome: 'blocked', reasons: [{ code: 'unknown_user', detail: 'no such user' }] }); continue; }
    const reasons = reasonsFor(c, t, get(c.userId), policy, areaCodes, hist);
    if (reasons.length) out.set(c.id, { outcome: 'blocked', reasons });
    else { out.set(c.id, { outcome: 'sent', reasons: [] }); hist.push({ userId: c.userId, channel: c.channel, t }); }
  }
  return out;
}
const summarize = out => { const byReason = {}; let sent = 0, blocked = 0; for (const r of out.values()) { if (r.outcome === 'sent') sent++; else { blocked++; byReason[r.reasons[0].code] = (byReason[r.reasons[0].code] || 0) + 1; } } return { sent, blocked, byReason }; };

export function compareWeek({ candidates, events = [], history = [], users, areaCodes, baselinePolicy, proposedPolicy }) {
  const um = new Map(users.map(u => [u.id, u]));
  const sorted = candidates.map(c => ({ c, t: Date.parse(c.at) })).sort((a, b) => (a.c.at < b.c.at ? -1 : a.c.at > b.c.at ? 1 : 0));
  const seen = new Set(), list = [];
  for (const x of sorted) { if (seen.has(x.c.id)) continue; seen.add(x.c.id); list.push(x); }
  const base = runPolicy(baselinePolicy, list, events, history, um, areaCodes);
  const prop = runPolicy(proposedPolicy, list, events, history, um, areaCodes);
  const messages = list.map(({ c }) => ({ id: c.id, at: c.at, userId: c.userId, channel: c.channel, baseline: base.get(c.id), proposed: prop.get(c.id) }));
  return {
    total: list.length, duplicatesDropped: candidates.length - list.length,
    baseline: summarize(base), proposed: summarize(prop), messages,
    newlyBlocked: messages.filter(m => m.baseline.outcome === 'sent' && m.proposed.outcome === 'blocked').map(m => m.id),
    newlyAllowed: messages.filter(m => m.baseline.outcome === 'blocked' && m.proposed.outcome === 'sent').map(m => m.id),
  };
}
