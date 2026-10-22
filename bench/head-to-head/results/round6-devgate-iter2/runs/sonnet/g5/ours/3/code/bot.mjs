// WhatsApp Business Platform (Cloud API) pre-send gate.
// Rules:
//  - Any business-initiated or reply message requires the patient's opt-in.
//  - Free-form ("text") messages are allowed only inside the 24-hour customer
//    service window, which starts at the patient's last inbound message.
//  - Template messages may be sent outside that window.
// Webhook `timestamp` is Unix time in SECONDS (not milliseconds), as a string.

const WINDOW_SECONDS = 24 * 60 * 60;
const CLOCK_SKEW_SECONDS = 5 * 60;

const allow = () => ({ allowed: true, reason: null });
const deny = (reason) => ({ allowed: false, reason });

function parseEpochSeconds(value) {
  if (typeof value !== "string" || !/^\d{1,12}$/.test(value.trim())) return null;
  return Number(value.trim());
}

export function decideWhatsApp(message, now) {
  if (!message || typeof message !== "object" || !message.contact || typeof message.contact !== "object") {
    return deny("invalid_message");
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return deny("invalid_clock");

  const { type, contact } = message;
  if (type !== "text" && type !== "template") return deny("unknown_message_type");

  if (contact.optedIn !== true) return deny("no_opt_in");

  if (type === "template") return allow();

  // type === "text": needs an open 24h window.
  const last = contact.lastInboundTimestamp;
  if (last === null || last === undefined) return deny("no_inbound_message");

  const lastSec = parseEpochSeconds(last);
  if (lastSec === null) return deny("invalid_inbound_timestamp");

  const nowSec = Math.floor(now.getTime() / 1000);
  const elapsed = nowSec - lastSec;
  if (elapsed < -CLOCK_SKEW_SECONDS) return deny("invalid_inbound_timestamp");
  if (elapsed >= WINDOW_SECONDS) return deny("outside_24h_window");

  return allow();
}
