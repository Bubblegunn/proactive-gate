import { test } from "node:test";
import assert from "node:assert/strict";
import { onInbound, check } from "./bot.mjs";

const H = 60 * 60 * 1000;
const t0 = new Date("2026-10-01T10:00:00Z");
let seq = 0;
const fresh = () => `user-${++seq}`;

test("never-written customer is blocked for both types", () => {
  const u = fresh();
  assert.deepEqual(check(u, "template", t0), { allowed: false, rule: "no-prior-inbound" });
  assert.deepEqual(check(u, "freeform", t0), { allowed: false, rule: "no-prior-inbound" });
});

test("freeform allowed inside 24h window, blocked at and after 24h", () => {
  const u = fresh();
  onInbound(u, "hi", t0);
  assert.deepEqual(check(u, "freeform", new Date(t0.getTime() + 23 * H)), { allowed: true, rule: null });
  assert.deepEqual(check(u, "freeform", new Date(t0.getTime() + 24 * H)), {
    allowed: false,
    rule: "freeform-window-closed",
  });
});

test("template allowed outside the window after any prior inbound", () => {
  const u = fresh();
  onInbound(u, "hello", t0);
  assert.deepEqual(check(u, "template", new Date(t0.getTime() + 100 * H)), { allowed: true, rule: null });
});

test("freeform check before the last inbound is blocked", () => {
  const u = fresh();
  onInbound(u, "hello", t0);
  assert.equal(check(u, "freeform", new Date(t0.getTime() - H)).rule, "freeform-window-closed");
});

test("stop keywords in any case, spacing, or punctuation opt out", () => {
  for (const text of ["STOP", "stop", " Stop! ", "stop.", "S.T.O.P", "s t o p", "STOPALL", "unsubscribe", "Cancel", "END", "quit", "stop 😊"]) {
    const u = fresh();
    onInbound(u, "hi", t0);
    onInbound(u, text, new Date(t0.getTime() + H));
    for (const type of ["template", "freeform"]) {
      assert.deepEqual(check(u, type, new Date(t0.getTime() + 2 * H)), { allowed: false, rule: "opted-out" }, `${text} / ${type}`);
    }
  }
});

test("polite free-text stop requests opt out", () => {
  for (const text of ["please stop texting me", "Stop messaging me.", "don't text me anymore", "Remove me please"]) {
    const u = fresh();
    onInbound(u, text, t0);
    assert.equal(check(u, "template", new Date(t0.getTime() + H)).rule, "opted-out", text);
  }
});

test("ordinary sentences containing keywords are not opt-outs", () => {
  for (const text of [
    "I will stop by the store later",
    "Can you cancel my order?",
    "Yes, my bill looks wrong",
    "the end of the month is fine",
    "do not stop the service please",
  ]) {
    const u = fresh();
    onInbound(u, text, t0);
    assert.deepEqual(check(u, "freeform", new Date(t0.getTime() + H)), { allowed: true, rule: null }, text);
  }
});

test("START, YES, UNSTOP restore consent after a stop", () => {
  for (const text of ["START", "yes", "Unstop!"]) {
    const u = fresh();
    onInbound(u, "hi", t0);
    onInbound(u, "STOP", new Date(t0.getTime() + H));
    onInbound(u, text, new Date(t0.getTime() + 2 * H));
    assert.deepEqual(check(u, "template", new Date(t0.getTime() + 3 * H)), { allowed: true, rule: null }, text);
  }
});

test("a stop is only undone by a later start, not by an older one", () => {
  const u = fresh();
  onInbound(u, "START", t0);
  onInbound(u, "STOP", new Date(t0.getTime() + H));
  onInbound(u, "hi again", new Date(t0.getTime() + 2 * H));
  assert.equal(check(u, "template", new Date(t0.getTime() + 3 * H)).rule, "opted-out");
});

test("late-arriving start does not override a newer stop", () => {
  const u = fresh();
  onInbound(u, "hi", t0);
  onInbound(u, "STOP", new Date(t0.getTime() + 2 * H));
  onInbound(u, "START", new Date(t0.getTime() + H));
  assert.equal(check(u, "template", new Date(t0.getTime() + 3 * H)).rule, "opted-out");
});

test("invalid inputs throw", () => {
  assert.throws(() => check(fresh(), "sms", t0), TypeError);
  assert.throws(() => check(fresh(), "freeform", new Date("nope")), TypeError);
  assert.throws(() => onInbound(fresh(), "hi", "2026-10-01"), TypeError);
});
