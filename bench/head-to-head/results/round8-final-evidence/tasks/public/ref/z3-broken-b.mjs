// Broken B for Z3 (a plausible mistake set). Standalone: node builtins only.
// Mistakes: a missing categories object is treated as "all categories on" (the push is allowed), the snooze is
// inclusive of its end instant (blocked while now <= snoozedUntil), and all state (dismissals, the day's push
// allowance) lives in this process's memory, never in STATE_DIR.
// Expected to FAIL criteria 2 (categories missing still pushes) and 6 (the snooze end instant is still snoozed).
// Criteria 1, 3, 4 and 5 pass. In-memory state is not caught by any Z3 criterion, because the checker runs
// everything in one process; that gap is recorded in the report, not hidden here.
const dismissals = [];
const pushesPerDay = new Map();

export async function deliver({ user, candidate, now, transport, consentStore }) {
  const type = candidate.type;
  const until = user.snoozedUntil ? Date.parse(user.snoozedUntil) : NaN;
  if (Number.isFinite(until) && now.getTime() <= until) {
    return { push: false, inApp: false, reason: "The user snoozed notifications, so this one is held.", resumeAt: new Date(until).toISOString() };
  }
  const categories = user.categories;
  if (categories && categories[type] === false) {
    return { push: false, inApp: false, reason: "The user switched this kind of notification off.", resumeAt: null };
  }
  let pushReason = null;
  if (categories && categories[type] !== true) {
    pushReason = "The user has not chosen to receive this kind of notification as a push.";
  }
  if (!pushReason && dismissals.filter((d) => d.user === user.id && d.type === type).length >= 3) {
    pushReason = "The user dismissed this kind of notification several times, so it stays in the app.";
  }
  if (!pushReason && user.platform === "android" && user.notificationsPermitted === false) {
    pushReason = "Notification permission is off on this Android phone, so no push is sent.";
  }
  if (!pushReason) {
    let consents = null;
    try {
      consents = await consentStore.get(user.id);
    } catch {
      consents = null;
    }
    if (!consents || consents.push !== true) pushReason = "Push consent could not be confirmed, so no push is sent.";
  }
  let push = false;
  if (!pushReason) {
    const day = now.toISOString().slice(0, 10);
    const key = `${user.id}|${day}`;
    if ((pushesPerDay.get(key) ?? 0) >= 1) {
      pushReason = "The one push for today is already used.";
    } else {
      let accepted = false;
      try {
        accepted = (await transport.push(user, candidate)) === true;
      } catch {
        accepted = false;
      }
      if (accepted) {
        pushesPerDay.set(key, (pushesPerDay.get(key) ?? 0) + 1);
        push = true;
      } else {
        pushReason = "The phone did not accept the push.";
      }
    }
  }
  let inApp = false;
  try {
    await transport.inApp(user, candidate);
    inApp = true;
  } catch {
    inApp = false;
  }
  return { push, inApp, reason: push ? null : pushReason, resumeAt: null };
}

export async function recordDismissal(userId, type, now) {
  dismissals.push({ user: userId, type, at: now });
}
