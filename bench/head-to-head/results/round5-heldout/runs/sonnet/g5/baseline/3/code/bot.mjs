// WhatsApp Business Platform (Cloud API) send gate.
//
// Rules:
// 1. Every message needs the patient's WhatsApp opt-in.
// 2. A template message may be sent at any time (to an opted-in patient).
// 3. A free-form text message may be sent only inside the 24-hour customer
//    service window, which starts at the patient's last inbound message.
//    Outside the window Meta rejects it (error 131047).
//
// The webhook `timestamp` is a UNIX time in SECONDS (not milliseconds), as a string.

const WINDOW_MS = 24 * 60 * 60 * 1000;
// Tolerance for our clock being slightly behind Meta's.
const FUTURE_SKEW_MS = 5 * 60 * 1000;

function parseInboundMs(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value * 1000;
  }
  if (typeof value === "string" && /^\d{1,15}$/.test(value.trim())) {
    return Number(value.trim()) * 1000;
  }
  return null;
}

export function decideWhatsApp(message, now) {
  const deny = (reason) => ({ allowed: false, reason });

  const contact = message?.contact;
  if (contact?.optedIn !== true) return deny("not_opted_in");

  const type = message.type;
  if (type === "template") return { allowed: true, reason: null };
  if (type !== "text") return deny("unknown_message_type");

  const raw = contact.lastInboundTimestamp;
  if (raw === null || raw === undefined) return deny("no_inbound_message");

  const inboundMs = parseInboundMs(raw);
  const nowMs = now instanceof Date ? now.getTime() : NaN;
  if (inboundMs === null || Number.isNaN(nowMs)) return deny("invalid_timestamp");

  const age = nowMs - inboundMs;
  if (age < -FUTURE_SKEW_MS) return deny("invalid_timestamp");
  if (age >= WINDOW_MS) return deny("outside_24h_window");

  return { allowed: true, reason: null };
}
