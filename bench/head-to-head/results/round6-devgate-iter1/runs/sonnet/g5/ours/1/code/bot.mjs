// WhatsApp Business Platform (Cloud API) pre-send gate.
// Rules:
//  - Every business-initiated message needs the patient's opt-in.
//  - Free-form ("text") messages are only allowed inside the 24-hour customer
//    service window, which starts at the patient's last inbound message.
//  - Template messages may be sent outside the window (with opt-in).
// Webhook `timestamp` is Unix time in SECONDS (as a string), not milliseconds.

const WINDOW_SECONDS = 24 * 60 * 60;
const CLOCK_SKEW_SECONDS = 5 * 60;

const deny = (reason) => ({ allowed: false, reason });

function parseUnixSeconds(value) {
  if (typeof value !== "string" || !/^\d{1,15}$/.test(value.trim())) return null;
  return Number(value.trim());
}

export function decideWhatsApp(message, now) {
  const type = message?.type;
  if (type !== "text" && type !== "template") return deny("unknown_message_type");

  if (message.contact?.optedIn !== true) return deny("not_opted_in");

  if (type === "template") return { allowed: true, reason: null };

  const raw = message.contact.lastInboundTimestamp;
  if (raw === null || raw === undefined) return deny("no_inbound_message");

  const inbound = parseUnixSeconds(raw);
  if (inbound === null) return deny("invalid_timestamp");

  const nowSeconds = now.getTime() / 1000;
  if (!Number.isFinite(nowSeconds)) return deny("invalid_clock");

  const elapsed = nowSeconds - inbound;
  if (elapsed < -CLOCK_SKEW_SECONDS) return deny("invalid_timestamp");
  if (elapsed >= WINDOW_SECONDS) return deny("outside_24h_window");

  return { allowed: true, reason: null };
}
