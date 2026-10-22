const fmts = new Map();
export function localMinutes(ms, tz) {
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
const inWin = (t, at, w) => t <= at && t > at - w; // MARK_WIN

function windowReasons(c, user, policy, areaCodes, ms) {
  const out = [];
  if (c.priority !== 'critical' && user.quiet) {
    const m = localMinutes(ms, user.tz); // MARK_QUIET
    if (inQuiet(m, user.quiet)) out.push({ code: 'quiet_hours', detail: `${hhmm(m)} in ${user.tz} is inside quiet hours ${user.quiet.start}-${user.quiet.end}` });
  }
  if (c.channel === 'sms' && typeof user.phone === 'string' && user.phone.startsWith('+1')) {
    const pairs = [{ tz: user.tz, state: user.state }];
    const ac = areaCodes[user.phone.slice(2, 5)];
    // area code ignored
    const bad = [];
    for (const p of pairs) {
      const w = (p.state && policy.legal[p.state]) || policy.legal.default;
      const m = localMinutes(ms, p.tz);
      if (m < toMin(w.start) || m >= toMin(w.end)) bad.push(`${hhmm(m)} in ${p.tz} is outside the ${p.state || 'default'} contact window ${w.start}-${w.end}`);
    }
    if (bad.length) out.push({ code: 'legal_window', detail: bad.join('; ') });
  }
  return out;
}

export function evaluate(c, { user, policy, areaCodes, history }) {
  const at = Date.parse(c.at);
  const reasons = [];
  if (user.optedOut === true) reasons.push({ code: 'opted_out', detail: 'recipient opted out of all messages' });
  if (user.consent?.[c.channel] !== true) reasons.push({ code: 'no_consent', detail: `no consent recorded for channel ${c.channel}` });
  if (user.snoozedUntil && at < Date.parse(user.snoozedUntil)) reasons.push({ code: 'snoozed', detail: `snoozed until ${user.snoozedUntil}` });
  reasons.push(...windowReasons(c, user, policy, areaCodes, at));
  const mine = history.filter(h => h.userId === user.id && h.status === 'sent').map(h => ({ ...h, t: Date.parse(h.at) }));
  const n24 = mine.filter(h => inWin(h.t, at, DAY));
  const n7 = mine.filter(h => inWin(h.t, at, 7 * DAY));
  const l24 = policy.caps.rolling24h, l7 = policy.caps.rolling7d, lc = policy.caps.channel24h?.[c.channel];
  if (l24 != null && n24.length >= l24) reasons.push({ code: 'rolling_24h_cap', detail: `${n24.length} messages sent in the last 24 hours, limit ${l24}` });
  if (l7 != null && n7.length >= l7) reasons.push({ code: 'rolling_7d_cap', detail: `${n7.length} messages sent in the last 7 days, limit ${l7}` });
  if (lc != null) { const nc = n24.filter(h => h.channel === c.channel).length; if (nc >= lc) reasons.push({ code: 'channel_24h_cap', detail: `${nc} ${c.channel} messages sent in the last 24 hours, limit ${lc}` }); }
  let retryAt = null;
  if (reasons.length && reasons.every(r => r.code === 'quiet_hours' || r.code === 'legal_window')) {
    let t = Math.floor(at / 60000) * 60000 + 60000;
    for (let i = 0; i < 72 * 60; i++, t += 60000) if (windowReasons(c, user, policy, areaCodes, t).length === 0) { retryAt = new Date(t).toISOString(); break; }
  }
  return { allowed: reasons.length === 0, reasons, retryAt };
}
