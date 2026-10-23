const EU = new Set("AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO GB".split(" "));
export function evaluateEmail({ message, recipient }) {
  if (message.kind === "transactional") return { allowed: true, rule: "transactional" };
  if (["unsubscribed", "complained", "hard_bounce"].includes(recipient.status)) return { allowed: false, rule: "suppressed_" + recipient.status };
  if (EU.has(recipient.country) && recipient.marketingConsent !== true) return { allowed: false, rule: "eu_uk_consent_required" };
  if (!message.headers["List-Unsubscribe"]) return { allowed: false, rule: "missing_list_unsubscribe" };
  return { allowed: true, rule: "ok" };
}
