export function checkSmsWindow(c, now) {
  try {
    if (!c || c.smsConsent !== true) return { allowed: false, reason: "no_consent", nextAllowedAt: null };
    const m = now.getUTCHours() * 60 + now.getUTCMinutes();
    if (m >= 480 && m < 1260) return { allowed: true, reason: "ok", nextAllowedAt: null };
    const n = new Date(now); n.setUTCHours(8, 0, 0, 0); if (n <= now) n.setUTCDate(n.getUTCDate() + 1);
    return { allowed: false, reason: "quiet_hours", nextAllowedAt: n.toISOString() };
  } catch { return { allowed: false, reason: "error", nextAllowedAt: null }; }
}
