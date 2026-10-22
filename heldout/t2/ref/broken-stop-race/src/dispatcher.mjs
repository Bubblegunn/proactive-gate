import fs from 'node:fs/promises';
import path from 'node:path';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const DAY = 86400000;
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
const STOP = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit']);
const START = new Set(['start', 'unstop']);

export function createDispatcher({ stateDir, provider, users, policy }) {
  const byId = new Map(users.map(u => [u.id, u]));
  const userFile = id => path.join(stateDir, 'users', `${id}.json`);
  const lockDir = id => path.join(stateDir, 'locks', id);

  async function withLock(id, fn) {
    await fs.mkdir(path.join(stateDir, 'locks'), { recursive: true });
    for (;;) {
      try { await fs.mkdir(lockDir(id)); break; } // MARK_LOCK
      catch (e) { if (e.code !== 'EEXIST') throw e; await sleep(1); }
    }
    try { return await fn(); } finally { await fs.rm(lockDir(id), { recursive: true, force: true }); }
  }
  async function load(id) {
    try { return JSON.parse(await fs.readFile(userFile(id), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return { msgs: {}, smsStopped: false }; throw e; }
  }
  async function save(id, st) {
    await fs.mkdir(path.join(stateDir, 'users'), { recursive: true });
    const f = userFile(id), tmp = `${f}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(st));
    await fs.rename(tmp, f);
  }
  const countIn = (st, t, w) => Object.values(st.msgs).filter(m => { const x = Date.parse(m.at); return x <= t && x > t - w; }).length;

  function check(msg, user, st) {
    const t = Date.parse(msg.at), reasons = [];
    if (user.consent?.[msg.channel] !== true) reasons.push({ code: 'no_consent', detail: `no consent recorded for channel ${msg.channel}` });
    if (msg.channel === 'sms' && st.smsStopped) reasons.push({ code: 'sms_stopped', detail: 'recipient replied STOP to sms' });
    if (msg.priority !== 'critical' && user.quiet) {
      const m = localMinutes(t, user.tz);
      if (inQuiet(m, user.quiet)) reasons.push({ code: 'quiet_hours', detail: `${hhmm(m)} in ${user.tz} is inside quiet hours ${user.quiet.start}-${user.quiet.end}` });
    }
    const lim = policy.caps.rolling24h, n = countIn(st, t, DAY);
    if (lim != null && n >= lim) reasons.push({ code: 'rolling_24h_cap', detail: `${n} messages counted in the last 24 hours, limit ${lim}` });
    return reasons;
  }

  return {
    dispatch(msg) {
      const user = byId.get(msg.userId);
      if (!user) throw new Error('unknown user ' + msg.userId);
      const earlyP = load(msg.userId);
      return withLock(msg.userId, async () => {
        const early = await earlyP;
        const st = await load(msg.userId);
        const prev = st.msgs[msg.id];
        if (prev && prev.status === 'sent') return { status: 'already_sent', providerId: prev.providerId, reasons: [] };
        if (!prev) {
          const reasons = check(msg, user, { ...st, smsStopped: early.smsStopped });
          if (reasons.length) return { status: 'blocked', reasons };
          st.msgs[msg.id] = { status: 'reserved', at: msg.at, channel: msg.channel };
          await save(msg.userId, st); // MARK_RESERVE
        }
        const res = await provider.send(msg, { idempotencyKey: `msg:${msg.id}` }); // MARK_KEY
        st.msgs[msg.id] = { ...st.msgs[msg.id], status: 'sent', providerId: res.providerId };
        await save(msg.userId, st);
        return { status: 'sent', providerId: res.providerId, reasons: [] };
      });
    },
    async handleInbound({ userId, channel, body }) {
      if (channel !== 'sms' || typeof body !== 'string') return { action: 'none' };
      const w = body.trim().replace(/[.!?]+$/, '').trim().toLowerCase();
      const action = STOP.has(w) ? 'stop' : START.has(w) ? 'start' : 'none';
      if (action === 'none') return { action };
      await withLock(userId, async () => { const st = await load(userId); st.smsStopped = action === 'stop'; await save(userId, st); });
      return { action };
    },
    usage(userId, at) {
      return withLock(userId, async () => { const st = await load(userId), t = Date.parse(at); return { rolling24h: countIn(st, t, DAY), rolling7d: countIn(st, t, 7 * DAY) }; });
    },
  };
}
