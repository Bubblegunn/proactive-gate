const blocked = new Set();
const norm = (p) => { const d = String(p).replace(/\D/g, ""); return d.length === 10 ? "1" + d : d; };
const STOP = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);
const START = new Set(["start", "unstop", "yes"]);
export function handleInbound({ from, to, body }) {
  const w = String(body ?? "").trim().toLowerCase();
  const key = norm(from) + "|" + norm(to);
  if (STOP.has(w)) { blocked.add(key); return "You have been unsubscribed and will receive no more messages from this number. Reply START to resubscribe."; }
  if (START.has(w)) { blocked.delete(key); return "You are subscribed again. Msg frequency varies. Reply HELP for help, STOP to cancel."; }
  if (w === "help") return "Help: contact support@shop.example or call 800-555-0100. Msg&data rates may apply. Reply STOP to cancel.";
  return null;
}
export function canSend({ phone, sender }) {
  return blocked.has(norm(phone) + "|" + norm(sender)) ? { allowed: false, rule: "customer_opted_out" } : { allowed: true, rule: "no_opt_out" };
}
