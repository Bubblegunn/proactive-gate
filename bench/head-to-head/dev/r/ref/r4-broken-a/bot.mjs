const S = new Map();
const g = (u) => { if (!S.has(u)) S.set(u, { optIn: null, optOut: null, inbound: null }); return S.get(u); };
const mx = (a, b) => (a === null ? b : Math.max(a, b));
export const recordOptIn = async (u, at) => { const s = g(u); s.optIn = mx(s.optIn, +at); };
export const recordOptOut = async (u, at) => { const s = g(u); s.optOut = mx(s.optOut, +at); };
export const recordInbound = async (u, at) => { const s = g(u); s.inbound = mx(s.inbound, +at); };
export const canSend = async ({ userId, now, kind }) => {
  const s = g(userId);
  if (s.optOut !== null && (s.optIn === null || s.optOut >= s.optIn)) return { allowed: false, rule: "opted_out" };
  if (s.optIn === null) return { allowed: false, rule: "no_opt_in" };
  if (kind === "template") return { allowed: true, rule: "template_with_opt_in" };
  if (s.inbound !== null && +now - s.inbound < 24 * 3600 * 1000) return { allowed: true, rule: "inside_24h_window" };
  return { allowed: false, rule: "outside_24h_window" };
};
