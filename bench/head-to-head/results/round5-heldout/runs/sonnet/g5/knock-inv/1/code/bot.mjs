// Pre-send gate for WhatsApp Business Platform (Cloud API) messages.
//
// Rules (WhatsApp Business Platform policy and Cloud API docs):
// 1. A business may message a person only after that person opted in to
//    WhatsApp messages from the business. This applies to every message type.
// 2. A free-form ("text") message is allowed only inside the 24-hour customer
//    service window, which opens when the person last sent us a message.
//    Outside the window, only an approved template message is allowed.
// 3. The webhook `timestamp` is a UNIX time in SECONDS (UTC), delivered as a string.

const WINDOW_SECONDS = 24 * 60 * 60;
// Tolerated difference between Meta's clock and our server clock.
const CLOCK_SKEW_SECONDS = 5 * 60;

const deny = (reason) => ({ allowed: false, reason });

export function decideWhatsApp(message, now) {
  if (!message || typeof message !== "object" || !message.contact || typeof message.contact !== "object") {
    return deny("invalid_message");
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return deny("invalid_now");
  }
  const { type, contact } = message;

  if (type !== "text" && type !== "template") {
    return deny("invalid_message_type");
  }

  // Strict check: a missing, string or truthy-but-not-true value is not consent.
  if (contact.optedIn !== true) {
    return deny("not_opted_in");
  }

  // Templates need only opt-in.
  if (type === "template") {
    return { allowed: true, reason: null };
  }

  // Free-form text needs an open customer service window.
  const ts = contact.lastInboundTimestamp;
  if (ts === null || ts === undefined) {
    return deny("outside_service_window");
  }
  if (typeof ts !== "string" || !/^\d{1,12}$/.test(ts)) {
    // Not epoch seconds (for example milliseconds, ISO text or a number type).
    return deny("invalid_timestamp");
  }

  const elapsed = Math.floor(now.getTime() / 1000) - Number(ts);
  if (elapsed < -CLOCK_SKEW_SECONDS) {
    return deny("invalid_timestamp");
  }
  // Window is 24 hours; at exactly 24 hours it counts as closed.
  if (elapsed >= WINDOW_SECONDS) {
    return deny("outside_service_window");
  }
  return { allowed: true, reason: null };
}
