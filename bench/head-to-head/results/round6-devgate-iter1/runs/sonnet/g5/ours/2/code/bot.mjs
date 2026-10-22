// WhatsApp Business Platform send gate (Cloud API).
// Rules:
//  1. No opt-in -> never send anything.
//  2. Template messages may start a conversation, so they are allowed with opt-in.
//  3. Free-form text is only allowed inside the 24h customer service window,
//     which starts at the patient's last inbound message.
// Webhook `timestamp` is Unix time in SECONDS (UTC), delivered as a string.

const WINDOW_SECONDS = 24 * 60 * 60;
const MAX_CLOCK_SKEW_SECONDS = 5 * 60;

const deny = (reason) => ({ allowed: false, reason });

export function decideWhatsApp(message, now) {
  const nowMs = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(nowMs)) return deny("invalid_clock");

  const contact = message?.contact;
  if (!contact || typeof contact !== "object") return deny("invalid_contact");

  // Strict: only the boolean true counts as consent.
  if (contact.optedIn !== true) return deny("not_opted_in");

  const type = message.type;
  if (type === "template") return { allowed: true, reason: null };
  if (type !== "text") return deny("unknown_message_type");

  const raw = contact.lastInboundTimestamp;
  if (raw === null || raw === undefined) return deny("no_inbound_message");

  // Meta sends epoch seconds as a digit string; reject anything else (fail closed).
  if (typeof raw !== "string" || !/^\d{1,15}$/.test(raw.trim())) {
    return deny("invalid_inbound_timestamp");
  }
  const inboundSec = Number(raw.trim());
  const nowSec = nowMs / 1000;
  const ageSec = nowSec - inboundSec;

  // A timestamp in the future (beyond small skew) is not trustworthy.
  if (ageSec < -MAX_CLOCK_SKEW_SECONDS) return deny("invalid_inbound_timestamp");

  if (ageSec >= WINDOW_SECONDS) return deny("customer_service_window_closed");
  return { allowed: true, reason: null };
}
