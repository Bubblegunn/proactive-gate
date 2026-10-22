// WhatsApp Business Platform (Cloud API) pre-send gate.
//
// Rules:
//  1. Business-initiated contact needs opt-in: contact.optedIn must be exactly true.
//  2. A template message may be sent at any time (to an opted-in contact).
//  3. A free-form (text) message is only allowed inside the 24-hour customer
//     service window, which starts at the patient's last inbound message.
//
// The webhook `timestamp` is a Unix time in SECONDS (UTC), delivered as a string.

const WINDOW_SECONDS = 24 * 60 * 60;
const MAX_CLOCK_SKEW_SECONDS = 5 * 60;

const deny = (reason) => ({ allowed: false, reason });

function parseWebhookTimestamp(value) {
  if (typeof value === "string" && /^\d{1,15}$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

export function decideWhatsApp(message, now) {
  const type = message?.type;
  if (type !== "text" && type !== "template") return deny("invalid_message_type");

  if (message.contact?.optedIn !== true) return deny("not_opted_in");

  if (type === "template") return { allowed: true, reason: null };

  const raw = message.contact.lastInboundTimestamp;
  if (raw === null || raw === undefined) return deny("outside_service_window");

  const inboundSeconds = parseWebhookTimestamp(raw);
  const nowMs = now instanceof Date ? now.getTime() : NaN;
  if (inboundSeconds === null || Number.isNaN(nowMs)) return deny("invalid_timestamp");

  const elapsed = Math.floor(nowMs / 1000) - inboundSeconds;
  if (elapsed < -MAX_CLOCK_SKEW_SECONDS) return deny("invalid_timestamp");
  if (elapsed >= WINDOW_SECONDS) return deny("outside_service_window");

  return { allowed: true, reason: null };
}
