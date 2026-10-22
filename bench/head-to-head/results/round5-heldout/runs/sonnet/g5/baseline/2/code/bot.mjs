// WhatsApp Business Platform (Cloud API) pre-send gate.
//
// Rules:
// 1. No opt-in -> never send anything (business-initiated messaging requires opt-in).
// 2. Template messages may be sent at any time (to opted-in contacts).
// 3. Free-form text is only allowed inside the 24-hour customer service
//    window, which starts at the patient's last inbound message.
//
// The webhook `timestamp` is a Unix time in SECONDS (UTC), delivered as a string.

const WINDOW_SECONDS = 24 * 60 * 60;
const CLOCK_SKEW_SECONDS = 5 * 60;

const block = (reason) => ({ allowed: false, reason });

export function decideWhatsApp(message, now) {
  if (!message || typeof message !== "object") return block("invalid_message");
  const { type, contact } = message;
  if (type !== "text" && type !== "template") return block("unsupported_message_type");
  if (!contact || typeof contact !== "object") return block("invalid_contact");

  if (contact.optedIn !== true) return block("no_opt_in");

  if (type === "template") return { allowed: true, reason: null };

  // Free-form text: needs an open customer service window.
  const nowMs = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(nowMs)) return block("invalid_clock");

  const raw = contact.lastInboundTimestamp;
  if (raw === null || raw === undefined) return block("no_inbound_message");
  if (typeof raw !== "string" || !/^\d{1,12}$/.test(raw.trim())) {
    return block("invalid_inbound_timestamp");
  }

  const inboundSeconds = Number(raw.trim()); // Unix seconds, not milliseconds
  const ageSeconds = nowMs / 1000 - inboundSeconds;

  if (ageSeconds < -CLOCK_SKEW_SECONDS) return block("invalid_inbound_timestamp");
  if (ageSeconds >= WINDOW_SECONDS) return block("service_window_closed");

  return { allowed: true, reason: null };
}
