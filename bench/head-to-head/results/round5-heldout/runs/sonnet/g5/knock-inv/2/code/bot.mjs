// Pre-send gate for WhatsApp Business Platform (Cloud API) messages.
//
// Rules:
// 1. Business-initiated or not, every message needs the patient's opt-in.
// 2. Template messages may be sent at any time (outside the window too).
// 3. Free-form "text" messages are allowed only inside the 24-hour customer
//    service window, which opens when the patient last messaged us.
//
// The webhook `timestamp` is a Unix time in SECONDS (not milliseconds), sent
// as a string.

const WINDOW_MS = 24 * 60 * 60 * 1000;
// Tolerated difference between Meta's clock and ours for a timestamp in the future.
const CLOCK_SKEW_MS = 5 * 60 * 1000;

const deny = (reason) => ({ allowed: false, reason });

export function decideWhatsApp(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }
  if (message === null || typeof message !== "object") {
    return deny("invalid_message");
  }
  const { type, contact } = message;
  if (type !== "text" && type !== "template") return deny("invalid_type");
  if (contact === null || typeof contact !== "object") return deny("invalid_contact");

  if (contact.optedIn !== true) return deny("opt_in_missing");

  if (type === "template") return { allowed: true, reason: null };

  const ts = contact.lastInboundTimestamp;
  if (ts === null || ts === undefined) return deny("no_inbound_message");
  if (typeof ts !== "string" || !/^\d{1,15}$/.test(ts)) return deny("invalid_timestamp");

  const inboundMs = Number(ts) * 1000;
  const ageMs = now.getTime() - inboundMs;
  if (ageMs < -CLOCK_SKEW_MS) return deny("invalid_timestamp");
  if (ageMs >= WINDOW_MS) return deny("outside_24h_window");

  return { allowed: true, reason: null };
}
