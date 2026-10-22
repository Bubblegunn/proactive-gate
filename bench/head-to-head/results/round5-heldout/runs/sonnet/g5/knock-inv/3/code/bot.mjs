// Pre-send gate for WhatsApp Business Platform (Cloud API) messages.
//
// Rules (Meta policy):
//   1. The patient must have opted in to WhatsApp messages from us. Applies to every message.
//   2. A free-form ("text") message is allowed only inside the 24-hour customer service
//      window, which starts at the patient's last inbound message.
//   3. A "template" message may be sent at any time (opt-in still required).
//
// The webhook `timestamp` is a Unix time in SECONDS (as a string), not milliseconds.

const WINDOW_SECONDS = 24 * 60 * 60;
// Meta's clock and ours can differ slightly; tolerate a small lead before calling it invalid.
const MAX_FUTURE_SKEW_SECONDS = 5 * 60;

function parseSeconds(value) {
  if (typeof value === "string" && /^\d{1,15}$/.test(value.trim())) {
    return Number(value.trim());
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  return null;
}

export function decideWhatsApp(message, now) {
  const deny = (reason) => ({ allowed: false, reason });

  const contact = message?.contact;
  const type = message?.type;

  if (type !== "text" && type !== "template") return deny("invalid_message_type");
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return deny("invalid_now");

  if (contact?.optedIn !== true) return deny("no_opt_in");

  if (type === "template") return { allowed: true, reason: null };

  // Free-form text: needs an inbound message within the last 24 hours.
  const raw = contact.lastInboundTimestamp;
  if (raw === null || raw === undefined) return deny("no_inbound_message");

  const inboundSec = parseSeconds(raw);
  if (inboundSec === null) return deny("invalid_inbound_timestamp");

  const elapsed = now.getTime() / 1000 - inboundSec;
  if (elapsed < -MAX_FUTURE_SKEW_SECONDS) return deny("invalid_inbound_timestamp");
  if (elapsed >= WINDOW_SECONDS) return deny("service_window_closed");

  return { allowed: true, reason: null };
}
