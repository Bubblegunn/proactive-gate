import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSend } from "./bot.mjs";

const user = (over = {}) => ({
  id: "u1",
  timeZone: "America/Chicago",
  sms: { optedIn: true, optedOutAt: null },
  ...over,
});
const mkt = (text = "Sale today! Reply STOP to opt out") => ({ kind: "marketing", text });
const txn = (text = "Your order shipped") => ({ kind: "transactional", text });
const at = (iso) => new Date(iso);
const run = (u, m, n) => checkSend({ user: u, message: m, now: n });

test("marketing allowed midday Chicago (CDT = UTC-5)", async () => {
  assert.deepEqual(await run(user(), mkt(), at("2026-10-23T17:00:00Z")), { allowed: true, rule: "" });
});

test("quiet-hours edges in Chicago", async () => {
  // 07:59 CDT held, 08:00 allowed, 20:59 allowed, 21:00 held
  assert.equal((await run(user(), mkt(), at("2026-10-23T12:59:00Z"))).rule, "quiet-hours");
  assert.equal((await run(user(), mkt(), at("2026-10-23T13:00:00Z"))).allowed, true);
  assert.equal((await run(user(), mkt(), at("2026-10-24T01:59:00Z"))).allowed, true);
  assert.equal((await run(user(), mkt(), at("2026-10-24T02:00:00Z"))).rule, "quiet-hours");
});

test("DST: same UTC clock time differs between winter and summer", async () => {
  // 13:30Z is 07:30 CST (held) in January, 08:30 CDT (allowed) in July
  assert.equal((await run(user(), mkt(), at("2026-01-15T13:30:00Z"))).rule, "quiet-hours");
  assert.equal((await run(user(), mkt(), at("2026-07-15T13:30:00Z"))).allowed, true);
});

test("India half-hour offset and Japan", async () => {
  const india = user({ timeZone: "Asia/Kolkata" });
  const japan = user({ timeZone: "Asia/Tokyo" });
  // 02:29Z = 07:59 IST held; 02:30Z = 08:00 IST allowed
  assert.equal((await run(india, mkt(), at("2026-10-23T02:29:00Z"))).rule, "quiet-hours");
  assert.equal((await run(india, mkt(), at("2026-10-23T02:30:00Z"))).allowed, true);
  // 12:00Z = 21:00 JST held; 11:59Z allowed
  assert.equal((await run(japan, mkt(), at("2026-10-23T12:00:00Z"))).rule, "quiet-hours");
  assert.equal((await run(japan, mkt(), at("2026-10-23T11:59:00Z"))).allowed, true);
});

test("midnight does not render as hour 24", async () => {
  const r = await run(user({ timeZone: "Asia/Tokyo" }), mkt(), at("2026-10-23T15:00:00Z")); // 00:00 JST
  assert.equal(r.rule, "quiet-hours");
});

test("consent", async () => {
  for (const sms of [{ optedIn: false, optedOutAt: null }, {}, { optedIn: "true" }, null]) {
    assert.equal((await run(user({ sms }), mkt(), at("2026-10-23T17:00:00Z"))).rule, "no-consent");
  }
});

test("opt-out blocks both kinds; bad timestamp and future timestamp still count", async () => {
  for (const optedOutAt of ["2026-10-01T10:00:00Z", "garbage", "2099-01-01T00:00:00Z", ""]) {
    const u = user({ sms: { optedIn: true, optedOutAt } });
    assert.equal((await run(u, mkt(), at("2026-10-23T17:00:00Z"))).rule, "opted-out");
    assert.equal((await run(u, txn(), at("2026-10-23T17:00:00Z"))).rule, "opted-out");
  }
});

test("transactional ignores consent flag, time zone and quiet hours", async () => {
  const u = user({ timeZone: null, sms: { optedIn: false, optedOutAt: null } });
  assert.deepEqual(await run(u, txn(), at("2026-10-23T09:00:00Z")), { allowed: true, rule: "" });
  assert.equal((await run(user(), txn(), at("2026-10-23T08:00:00Z"))).allowed, true); // 03:00 Chicago
  assert.equal((await run(user(), txn(), new Date("nope"))).allowed, true);
});

test("marketing needs a usable time zone", async () => {
  for (const timeZone of [null, undefined, "", "EST", "UTC", "Etc/UTC", "Mars/Olympus", "America/Chicag", 5, {}]) {
    assert.equal((await run(user({ timeZone }), mkt(), at("2026-10-23T17:00:00Z"))).rule, "unknown-timezone", String(timeZone));
  }
});

test("marketing needs opt-out instructions", async () => {
  assert.equal((await run(user(), mkt("Sale today!"), at("2026-10-23T17:00:00Z"))).rule, "no-opt-out-info");
  assert.equal((await run(user(), mkt("Stop by our booth"), at("2026-10-23T17:00:00Z"))).rule, "no-opt-out-info");
  assert.equal((await run(user(), mkt("Sale! text stop to end"), at("2026-10-23T17:00:00Z"))).allowed, true);
});

test("invalid now for marketing", async () => {
  for (const now of [undefined, null, new Date("x"), "2026-10-23T17:00:00Z", 0]) {
    assert.equal((await run(user(), mkt(), now)).rule, "invalid-time");
  }
});

test("unknown kind is marketing", async () => {
  const u = user({ sms: { optedIn: false, optedOutAt: null } });
  assert.equal((await run(u, { kind: "promo", text: "x" }, at("2026-10-23T17:00:00Z"))).rule, "no-consent");
});

test("never throws on odd input", async () => {
  const odd = [undefined, null, 0, "x", [], {}, () => {}, Symbol("s")];
  for (const a of odd) {
    for (const b of odd) {
      const r = await checkSend({ user: a, message: b, now: a });
      assert.equal(typeof r.allowed, "boolean");
      assert.equal(typeof r.rule, "string");
    }
  }
  assert.equal((await checkSend()).rule, "invalid-input");
  assert.equal((await checkSend(null)).allowed, false);
  assert.equal((await run(user(), { kind: "marketing", text: 5 }, new Date())).rule, "empty-message");
  assert.equal((await run(user(), { kind: "marketing", text: "  " }, new Date())).rule, "empty-message");
  const hostile = { get sms() { throw new Error("boom"); }, timeZone: "America/Chicago" };
  assert.equal((await run(hostile, mkt(), new Date())).rule, "internal-error");
});

test("allowed result has empty rule; held result has non-empty rule", async () => {
  const ok = await run(user(), mkt(), at("2026-10-23T17:00:00Z"));
  const no = await run(user(), mkt(), at("2026-10-23T05:00:00Z"));
  assert.equal(ok.rule, "");
  assert.ok(no.rule.length > 0);
});
