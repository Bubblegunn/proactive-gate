import test from "node:test";
import assert from "node:assert/strict";
import { checkSend } from "./bot.mjs";

const user = (over = {}) => ({
  id: "u1",
  timeZone: "America/Chicago",
  sms: { optedIn: true, optedOutAt: null },
  ...over,
});
const mkt = (text = "Big box news! Reply STOP to opt out.") => ({ kind: "marketing", text });
const txn = (text = "Your order #123 has shipped.") => ({ kind: "transactional", text });
const at = (iso) => new Date(iso);

async function rule(args) {
  const r = await checkSend(args);
  assert.equal(r.allowed, r.rule === "");
  return r.rule;
}

test("marketing inside the local window is allowed (Fri 10:00 CDT)", async () => {
  assert.equal(await rule({ user: user(), message: mkt(), now: at("2026-10-23T15:00:00Z") }), "");
});

test("same UTC instant is judged in the customer's zone", async () => {
  const now = at("2026-10-24T01:30:00Z"); // 20:30 Chicago, 10:30 Tokyo, 07:00 Kolkata
  assert.equal(await rule({ user: user(), message: mkt(), now }), "quiet-hours");
  assert.equal(await rule({ user: user({ timeZone: "Asia/Tokyo" }), message: mkt(), now }), "");
  assert.equal(await rule({ user: user({ timeZone: "Asia/Kolkata" }), message: mkt(), now }), "quiet-hours");
});

test("window edges and DST", async () => {
  const m = mkt();
  // Mon 2026-11-02 is CST (UTC-6) after the Nov 1 fall-back.
  assert.equal(await rule({ user: user(), message: m, now: at("2026-11-02T14:59:00Z") }), "quiet-hours");
  assert.equal(await rule({ user: user(), message: m, now: at("2026-11-02T15:00:00Z") }), "");
  assert.equal(await rule({ user: user(), message: m, now: at("2026-11-03T01:59:00Z") }), ""); // 19:59
  assert.equal(await rule({ user: user(), message: m, now: at("2026-11-03T02:00:00Z") }), "quiet-hours"); // 20:00
});

test("Sunday starts at noon", async () => {
  assert.equal(await rule({ user: user(), message: mkt(), now: at("2026-10-25T15:00:00Z") }), "quiet-hours");
  assert.equal(await rule({ user: user(), message: mkt(), now: at("2026-10-25T18:00:00Z") }), "");
});

test("bad or missing time zone holds marketing, not transactional", async () => {
  const now = at("2026-10-23T15:00:00Z");
  for (const timeZone of [null, undefined, "", "Mars/Base", "UTC", "Etc/GMT+5", "+05:00", 42]) {
    assert.equal(await rule({ user: user({ timeZone }), message: mkt(), now }), "unknown-time-zone", String(timeZone));
    assert.equal(await rule({ user: user({ timeZone }), message: txn(), now }), "");
  }
});

test("consent", async () => {
  const now = at("2026-10-23T15:00:00Z");
  const noConsent = user({ sms: { optedIn: false, optedOutAt: null } });
  assert.equal(await rule({ user: noConsent, message: mkt(), now }), "no-consent");
  assert.equal(await rule({ user: user({ sms: { optedIn: "true", optedOutAt: null } }), message: mkt(), now }), "no-consent");
  assert.equal(await rule({ user: user({ sms: undefined }), message: mkt(), now }), "no-consent");
});

test("STOP holds every kind, including odd values", async () => {
  const now = at("2026-10-23T15:00:00Z");
  for (const optedOutAt of ["2026-10-01T12:00:00Z", "2030-01-01T00:00:00Z", "garbage", "", 0]) {
    const u = user({ sms: { optedIn: true, optedOutAt } });
    assert.equal(await rule({ user: u, message: mkt(), now }), "opted-out");
    assert.equal(await rule({ user: u, message: txn(), now }), "opted-out");
  }
});

test("transactional ignores quiet hours", async () => {
  assert.equal(await rule({ user: user(), message: txn("Your code is 123456"), now: at("2026-10-23T08:00:00Z") }), "");
});

test("transactional label with promo content is treated as marketing", async () => {
  const now = at("2026-10-23T08:00:00Z"); // 03:00 Chicago
  const m = txn("Your order shipped! Use code SAVE20 for 20% off your next box. Reply STOP to opt out.");
  assert.equal(await rule({ user: user(), message: m, now }), "quiet-hours");
  assert.equal(await rule({ user: user({ sms: { optedIn: false, optedOutAt: null } }), message: m, now }), "no-consent");
});

test("unknown kind counts as marketing", async () => {
  const now = at("2026-10-23T08:00:00Z");
  assert.equal(await rule({ user: user(), message: { kind: "other", text: "hi STOP" }, now }), "quiet-hours");
});

test("marketing needs opt-out instructions", async () => {
  const now = at("2026-10-23T15:00:00Z");
  assert.equal(await rule({ user: user(), message: mkt("Sale today only"), now }), "missing-opt-out-text");
});

test("invalid now holds marketing only", async () => {
  for (const now of [undefined, null, "2026-10-23T15:00:00Z", new Date("x"), 5]) {
    assert.equal(await rule({ user: user(), message: mkt(), now }), "invalid-time");
    assert.equal(await rule({ user: user(), message: txn(), now }), "");
  }
});

test("never throws on odd input", async () => {
  const now = at("2026-10-23T15:00:00Z");
  const odd = [undefined, null, 0, "x", [], () => {}, { sms: null }, { get sms() { throw new Error("boom"); } }];
  for (const u of odd) for (const m of [undefined, null, "x", {}, { kind: "marketing" }, { kind: "marketing", text: 5 }, mkt()]) {
    const r = await checkSend({ user: u, message: m, now });
    assert.equal(typeof r.allowed, "boolean");
    assert.equal(typeof r.rule, "string");
  }
  assert.deepEqual(await checkSend(), { allowed: false, rule: "invalid-input" });
  assert.deepEqual(await checkSend(null).catch(() => "threw"), { allowed: false, rule: "invalid-input" });
});
