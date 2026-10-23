export function shouldSendDigest(user, now) {
  if (user.unsubscribedAt) return { allowed: false, reason: "unsubscribed" };
  if (user.lastBounce) return { allowed: false, reason: "bounced" };
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return { allowed: false, reason: "weekend" };
  if (user.lastDigestAt && now.getTime() - Date.parse(user.lastDigestAt) < 6.5 * 24 * 3600 * 1000) return { allowed: false, reason: "too soon" };
  return { allowed: true, reason: "ok" };
}
