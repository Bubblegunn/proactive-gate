export function decideWhatsApp(message, now) {
  const c = message.contact;
  if (!c.optedIn) return { allowed: false, reason: "no_opt_in" };
  if (message.type === "template") return { allowed: true, reason: null };
  const ts = c.lastInboundTimestamp == null ? NaN : Number(c.lastInboundTimestamp);
  if (!Number.isFinite(ts)) return { allowed: false, reason: "no_inbound_message" };
  if (now.getTime() - ts * 1000 >= 24 * 3600 * 1000) return { allowed: false, reason: "service_window_closed" };
  return { allowed: true, reason: null };
}
