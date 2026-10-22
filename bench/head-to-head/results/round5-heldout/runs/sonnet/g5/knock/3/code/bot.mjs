// WhatsApp Business Platform (Cloud API) send gate.
//
// Rules:
// 1. Every business message needs the patient's opt-in (optedIn === true).
// 2. A template message may be sent at any time (after opt-in).
// 3. A free-form text message may only be sent inside the 24-hour customer
//    service window, which opens when the patient last wrote to us.
//    The webhook `timestamp` is a Unix time in SECONDS (UTC), sent as a string.

const WINDOW_SECONDS = 24 * 60 * 60;
// Tolerated difference if our clock is behind Meta's clock.
const CLOCK_SKEW_SECONDS = 300;

const deny = (reason) => ({ allowed: false, reason });

export function decideWhatsApp(message, now) {
  const type = message?.type;
  if (type !== "text" && type !== "template") return deny("invalid_message_type");

  const contact = message.contact;
  if (!contact || typeof contact !== "object") return deny("opt_in_missing");
  if (contact.optedIn !== true) return deny("opt_in_missing");

  if (type === "template") return { allowed: true, reason: null };

  const nowMs = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(nowMs)) return deny("invalid_clock");

  const raw = contact.lastInboundTimestamp;
  if (raw === null || raw === undefined) return deny("no_customer_service_window");

  // Meta delivers digits only, in seconds. Reject anything else (e.g. milliseconds
  // would appear as a far-future time and be caught below).
  if (typeof raw !== "string" || !/^\d{1,15}$/.test(raw.trim())) {
    return deny("invalid_inbound_timestamp");
  }
  const inboundSeconds = Number(raw.trim());
  const elapsed = nowMs / 1000 - inboundSeconds;

  if (elapsed < -CLOCK_SKEW_SECONDS) return deny("invalid_inbound_timestamp");
  if (elapsed >= WINDOW_SECONDS) return deny("customer_service_window_expired");

  return { allowed: true, reason: null };
}
