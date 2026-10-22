// WhatsApp Business Platform (Cloud API) pre-send gate.
//
// Rules:
// - No send without the patient's WhatsApp opt-in (applies to every type).
// - Template messages may start a conversation outside the window.
// - Free-form text is only allowed inside the 24-hour customer service window,
//   which opens when the patient last messaged us. The webhook `timestamp` is
//   Unix time in SECONDS (UTC), not milliseconds.

const WINDOW_SECONDS = 24 * 60 * 60;
// Tolerated gap if our clock runs slightly behind Meta's.
const CLOCK_SKEW_SECONDS = 5 * 60;

const deny = (reason) => ({ allowed: false, reason });

function parseWebhookTimestamp(value) {
  if (typeof value === "string" && /^\d{1,15}$/.test(value)) return Number(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  return null;
}

export function decideWhatsApp(message, now) {
  const nowMs = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(nowMs)) return deny("invalid_clock");

  const type = message?.type;
  const contact = message?.contact;
  if (type !== "text" && type !== "template") return deny("invalid_message_type");
  if (contact === null || typeof contact !== "object") return deny("not_opted_in");

  if (contact.optedIn !== true) return deny("not_opted_in");

  if (type === "template") return { allowed: true, reason: null };

  if (contact.lastInboundTimestamp === null || contact.lastInboundTimestamp === undefined) {
    return deny("no_inbound_message");
  }
  const inboundSec = parseWebhookTimestamp(contact.lastInboundTimestamp);
  if (inboundSec === null) return deny("invalid_inbound_timestamp");

  const elapsedSec = nowMs / 1000 - inboundSec;
  if (elapsedSec < -CLOCK_SKEW_SECONDS) return deny("invalid_inbound_timestamp");
  if (elapsedSec >= WINDOW_SECONDS) return deny("outside_service_window");

  return { allowed: true, reason: null };
}
