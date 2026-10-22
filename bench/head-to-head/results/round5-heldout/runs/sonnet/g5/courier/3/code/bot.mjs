// WhatsApp Business Platform (Cloud API) pre-send gate.
//
// Rules:
//  1. The patient must have opted in to WhatsApp messages (applies to every message).
//  2. A template message may be sent at any time (business-initiated or not).
//  3. A free-form text message may only be sent inside the 24-hour customer service
//     window, which opens when the patient last sent us a message.
//
// The webhook `timestamp` is a Unix time in SECONDS (UTC), delivered as a string.

const WINDOW_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

const deny = (reason) => ({ allowed: false, reason });

export function decideWhatsApp(message, now) {
  if (!message || typeof message !== "object" || !message.contact || typeof message.contact !== "object") {
    return deny("invalid_message");
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return deny("invalid_now");

  const { type, contact } = message;
  if (type !== "text" && type !== "template") return deny("invalid_type");

  if (contact.optedIn !== true) return deny("not_opted_in");

  if (type === "template") return { allowed: true, reason: null };

  // type === "text": needs an open customer service window.
  const raw = contact.lastInboundTimestamp;
  if (raw === null || raw === undefined) return deny("no_inbound_message");
  if (typeof raw !== "string" || !/^\d{1,15}$/.test(raw.trim())) return deny("invalid_timestamp");

  const inboundMs = Number(raw.trim()) * 1000; // seconds -> milliseconds
  const age = now.getTime() - inboundMs;
  if (age < -CLOCK_SKEW_MS) return deny("invalid_timestamp"); // in the future (e.g. milliseconds)
  if (age >= WINDOW_MS) return deny("service_window_closed");

  return { allowed: true, reason: null };
}
