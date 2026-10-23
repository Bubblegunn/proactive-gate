const WEEK = 7 * 24 * 3600 * 1000;
export function shouldSendDigest(user, now) {
  if (user.unsubscribedAt) return { allowed: false, reason: "Person unsubscribed or complained (CAN-SPAM opt-out)" };
  if (user.lastBounce && user.lastBounce.type === "hard") return { allowed: false, reason: "Address hard-bounced; suppressed" };
  if (user.lastDigestAt) {
    const last = Date.parse(user.lastDigestAt);
    if (!Number.isNaN(last) && now.getTime() - last < WEEK - 12 * 3600 * 1000) return { allowed: false, reason: "A digest was sent within the last week" };
  }
  return { allowed: true, reason: "No suppression applies" };
}
