// WhatsApp Business Platform send gate. Pure and synchronous: no I/O, no stored state.
//
// Rules (Meta Cloud API / WhatsApp Business policy):
//  - Never message a contact who has not opted in on WhatsApp.
//  - A free-form "text" message is only allowed inside the 24-hour customer
//    service window, which runs from the patient's most recent inbound message.
//  - A "template" message (pre-approved) may start a conversation or be sent
//    outside the window.
//
// The webhook `timestamp` is Unix time in SECONDS, as a string (not milliseconds).

const WINDOW_SECONDS = 24 * 60 * 60;
// Meta's clock and ours can differ slightly; tolerate a small lead, no more.
const MAX_CLOCK_SKEW_SECONDS = 5 * 60;

function parseInboundSeconds(value) {
  if (typeof value !== "string" || !/^\d{1,15}$/.test(value)) return null;
  return Number(value);
}

export function decideWhatsApp(message, now) {
  const deny = (reason) => ({ allowed: false, reason });

  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return deny("invalid_now");
  if (message === null || typeof message !== "object") return deny("invalid_message");

  const { type, contact } = message;
  if (type !== "text" && type !== "template") return deny("invalid_message_type");
  if (contact === null || typeof contact !== "object") return deny("invalid_contact");

  // Opt-in applies to every message type; anything but literal true fails closed.
  if (contact.optedIn !== true) return deny("not_opted_in");

  if (type === "template") return { allowed: true, reason: null };

  // Free-form text needs an open 24-hour window.
  const raw = contact.lastInboundTimestamp;
  if (raw === null || raw === undefined) return deny("no_inbound_message");

  const inboundSeconds = parseInboundSeconds(raw);
  if (inboundSeconds === null) return deny("invalid_inbound_timestamp");

  const ageSeconds = now.getTime() / 1000 - inboundSeconds;
  if (ageSeconds < -MAX_CLOCK_SKEW_SECONDS) return deny("invalid_inbound_timestamp");
  if (ageSeconds >= WINDOW_SECONDS) return deny("outside_24h_window");

  return { allowed: true, reason: null };
}
