// WhatsApp Business Platform (Cloud API) pre-send gate.
//
// Rules:
//  1. Every business-initiated message needs the patient's WhatsApp opt-in
//     (applies to text and template messages).
//  2. Free-form ("text") messages are allowed only inside the 24-hour customer
//     service window, which starts at the patient's last inbound message.
//  3. Outside the window (or with no inbound message ever), only pre-approved
//     template messages are allowed.
//
// The webhook `timestamp` is Unix time in SECONDS (UTC), delivered as a string.

const WINDOW_SECONDS = 24 * 60 * 60;
const CLOCK_SKEW_SECONDS = 5 * 60; // tolerated difference between Meta's and our clock

const deny = (reason) => ({ allowed: false, reason });
const allow = () => ({ allowed: true, reason: null });

function parseInboundSeconds(value) {
  if (typeof value !== "string" || !/^\d{1,12}$/.test(value.trim())) return null;
  return Number(value.trim());
}

export function decideWhatsApp(message, now) {
  const type = message?.type;
  if (type !== "text" && type !== "template") return deny("invalid_message_type");

  const nowMs = now instanceof Date ? now.getTime() : NaN;
  if (Number.isNaN(nowMs)) return deny("invalid_now");

  if (message.contact?.optedIn !== true) return deny("not_opted_in");

  if (type === "template") return allow();

  const raw = message.contact.lastInboundTimestamp;
  if (raw === null || raw === undefined) return deny("no_inbound_message");

  const inbound = parseInboundSeconds(raw);
  if (inbound === null) return deny("invalid_inbound_timestamp");

  const ageSeconds = nowMs / 1000 - inbound;
  if (ageSeconds < -CLOCK_SKEW_SECONDS) return deny("invalid_inbound_timestamp");
  if (ageSeconds >= WINDOW_SECONDS) return deny("outside_24h_window");

  return allow();
}
