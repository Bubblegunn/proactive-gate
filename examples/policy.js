// A policy module for `proactive-gate replay --policy examples/policy.js`.
// Exports a gate; the replay feeds it the events and prints the report.
import { createGate, checks } from "proactive-gate";

export const gate = createGate({
  checks: [
    checks.killSwitch(() => process.env.PROACTIVE_KILL === "1"),
    checks.consent(),
    checks.enabled(),
    checks.mode({ allow: ["normal", "commute"] }),
    checks.snooze(),
    checks.mute(),
    checks.intensity(),
    checks.quietHours({ priorityFloor: "high" }),
    checks.trustRamp({ days: 7, minPriority: "high" }),
    checks.dismissalCooldown({ dismissals: 3, withinDays: 30, silenceDays: 7 }),
    checks.adaptiveTiming({
      // Push nothing between 12:00 and 13:00 local; move it to 13:05.
      nextGoodMoment: ({ now, user }) => {
        if (!user.timezone) return null;
        const local = new Intl.DateTimeFormat("en-US", { timeZone: user.timezone, hour: "numeric", hourCycle: "h23" }).format(now);
        if (Number(local) !== 12) return null;
        return new Date(now.getTime() + 65 * 60 * 1000);
      },
    }),
    checks.dailyBudget({ limit: 3, bypassPriority: "critical" }),
  ],
});
