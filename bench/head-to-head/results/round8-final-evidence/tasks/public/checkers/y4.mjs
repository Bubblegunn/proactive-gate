// Checker for Y4 (deliver and whyNothing: consent, quiet hours, daily cap; state shared by worker processes).
// usage: node y4.mjs <dir containing bot.mjs>
//
// Every deliver or whyNothing call that the scenario needs runs in its own process (run() from proc.mjs), so the
// state has to live on disk and survive the process. The concurrency case starts two processes at once.
// Local clock readings were cross-checked with Intl.DateTimeFormat (outside this file):
//   Europe/Istanbul is UTC+3 all year. 2026-09-04T09:00Z = 12:00, 19:30Z = 22:30, 20:00Z = 23:00,
//   20:59:59Z = 23:59:59, 21:00Z = 00:00 on 5 Sep, 2026-09-05T03:00Z = 06:00, 04:00Z = 07:00.
//   America/New_York is EDT (UTC-4) on 2026-09-04 and 2026-09-05, EST (UTC-5) before 2026-03-08 07:00Z.
//   2026-09-05T01:00Z = 21:00 on 4 Sep local, 11:30Z = 07:30 on 5 Sep local.
// Expected results are literals below; the scenario table is the single source for the sequence checks.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Report } from "./lib.mjs";
import { run } from "./proc.mjs";

const dir = process.argv[2];
const r = new Report();
const IST = "Europe/Istanbul";
const NY = "America/New_York";
const WHOLE = ["2026-09-04T00:00:00Z", "2026-09-06T00:00:00Z"];
const RULES = ["consent", "quietHours", "dailyCap"];
const RULE_WORD = { consent: /consent/i, quietHours: /quiet hours/i, dailyCap: /daily limit/i };
const made = [];

const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "y4-"));
  made.push(d);
  return join(d, "state");
};
const one = async (state, fn, args) => (await run(dir, state, [{ fn, args }]))[0];
const dv = (state, id, consent, msg, now, tz = IST) =>
  one(state, "deliver", { user: { id, timezone: tz, consent }, message: { id: msg }, now });
const why = (state, userId, from, to) => one(state, "whyNothing", { userId, from, to });
const sameInstant = (a, iso) => typeof a === "string" && Date.parse(a) === Date.parse(iso);
const hasText = (v) => typeof v === "string" ? v.toLowerCase() : "";

// The scenario, in order. rule null means delivered. Each row is one deliver call in its own process.
const TABLE = [
  { u: "u1", consent: false, m: "m1", at: "2026-09-04T09:00:00Z", rule: "consent" },
  { u: "u1", consent: false, m: "m2", at: "2026-09-04T10:00:00Z", rule: "consent" },
  { u: "u1", consent: false, m: "m3", at: "2026-09-04T11:00:00Z", rule: "consent" },
  { u: "u1", consent: false, m: "m4", at: "2026-09-05T09:00:00Z", rule: "consent" },
  { u: "u2", consent: true, m: "m1", at: "2026-09-04T09:00:00Z", rule: null },
  { u: "u2", consent: true, m: "m2", at: "2026-09-04T10:00:00Z", rule: null },
  { u: "u2", consent: true, m: "m3", at: "2026-09-04T11:00:00Z", rule: "dailyCap" },
  { u: "u2", consent: true, m: "m4", at: "2026-09-04T19:30:00Z", rule: "quietHours" },
  { u: "u2", consent: true, m: "m5", at: "2026-09-05T03:00:00Z", rule: "quietHours" },
  { u: "u2", consent: true, m: "m6", at: "2026-09-05T04:00:00Z", rule: null },
  { u: "u3", consent: true, m: "t1", at: "2026-09-04T19:30:00Z", rule: "quietHours" },
  { u: "u3", consent: true, m: "t2", at: "2026-09-04T20:00:00Z", rule: "quietHours" },
  { u: "u3", consent: true, m: "t3", at: "2026-09-05T03:30:00Z", rule: "quietHours" },
  { u: "u4", consent: false, m: "p1", at: "2026-09-04T20:00:00Z", rule: "consent" },
];

async function scenario(state) {
  for (const c of TABLE) await dv(state, c.u, c.consent, c.m, c.at);
  return state;
}

// Compares one whyNothing answer with an expectation. Phrases in verdict are matched case-insensitively.
function checkWhy(note, label, res, exp) {
  if (!res || typeof res !== "object" || res.error) {
    note(`${label}: no answer (${JSON.stringify(res)})`);
    return false;
  }
  let ok = true;
  if (res.delivered !== exp.delivered) {
    ok = false;
    note(`${label}: delivered ${JSON.stringify(res.delivered)}, expected ${exp.delivered}`);
  }
  if (!Array.isArray(res.blocked) || res.blocked.length !== exp.blocked.length) {
    note(`${label}: blocked has ${Array.isArray(res.blocked) ? res.blocked.length : "no list"} items, expected ${exp.blocked.length}`);
    return false;
  }
  exp.blocked.forEach((want, i) => {
    const got = res.blocked[i];
    if (!got || got.messageId !== want.messageId || got.rule !== want.rule || !sameInstant(got.at, want.at)) {
      ok = false;
      note(`${label}: blocked[${i}] is ${JSON.stringify(got)}, expected ${want.messageId} at ${want.at} rule ${want.rule}`);
    } else if (typeof got.reason !== "string" || !RULE_WORD[want.rule].test(got.reason)) {
      ok = false;
      note(`${label}: blocked[${i}] reason "${got.reason}" lacks the rule's words`);
    }
  });
  for (const rule of RULES) {
    const got = (res.byRule && res.byRule[rule]) ?? 0;
    const want = (exp.byRule && exp.byRule[rule]) ?? 0;
    if (got !== want) {
      ok = false;
      note(`${label}: byRule.${rule} is ${got}, expected ${want}`);
    }
  }
  const verdict = hasText(res.verdict);
  for (const phrase of exp.verdictHas) {
    if (!verdict.includes(phrase)) {
      ok = false;
      note(`${label}: verdict "${res.verdict}" lacks "${phrase}"`);
    }
  }
  return ok;
}

// ---------- criteria ----------

await r.crit("1 deliver results: every call of the scenario, consent before quiet hours before daily cap", async (note) => {
  const state = fresh();
  let ok = true;
  for (const c of TABLE) {
    const got = await dv(state, c.u, c.consent, c.m, c.at);
    const want = c.rule === null ? { delivered: true, rule: null } : { delivered: false, rule: c.rule };
    if (!got || got.delivered !== want.delivered || (got.rule ?? null) !== want.rule) {
      ok = false;
      note(`${c.u} ${c.m} at ${c.at}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
    }
  }
  return ok;
});

await r.crit("2 whyNothing: blocked lists, byRule counts and verdicts for u3, u1 and u2 over the whole range", async (note) => {
  const state = await scenario(fresh());
  const u3 = await why(state, "u3", ...WHOLE);
  const u1 = await why(state, "u1", ...WHOLE);
  const u2 = await why(state, "u2", ...WHOLE);
  let ok = true;
  ok = checkWhy(note, "u3", u3, {
    delivered: 0,
    blocked: [
      { messageId: "t1", at: "2026-09-04T19:30:00Z", rule: "quietHours" },
      { messageId: "t2", at: "2026-09-04T20:00:00Z", rule: "quietHours" },
      { messageId: "t3", at: "2026-09-05T03:30:00Z", rule: "quietHours" },
    ],
    byRule: { quietHours: 3 },
    verdictHas: ["nothing was delivered", "quiet hours"],
  }) && ok;
  ok = checkWhy(note, "u1", u1, {
    delivered: 0,
    blocked: [
      { messageId: "m1", at: "2026-09-04T09:00:00Z", rule: "consent" },
      { messageId: "m2", at: "2026-09-04T10:00:00Z", rule: "consent" },
      { messageId: "m3", at: "2026-09-04T11:00:00Z", rule: "consent" },
      { messageId: "m4", at: "2026-09-05T09:00:00Z", rule: "consent" },
    ],
    byRule: { consent: 4 },
    verdictHas: ["nothing was delivered", "consent"],
  }) && ok;
  ok = checkWhy(note, "u2", u2, {
    delivered: 3,
    blocked: [
      { messageId: "m3", at: "2026-09-04T11:00:00Z", rule: "dailyCap" },
      { messageId: "m4", at: "2026-09-04T19:30:00Z", rule: "quietHours" },
      { messageId: "m5", at: "2026-09-05T03:00:00Z", rule: "quietHours" },
    ],
    byRule: { dailyCap: 1, quietHours: 2 },
    verdictHas: ["delivered"],
  }) && ok;
  return ok;
});

await r.crit("3 range semantics: from inclusive, to exclusive; empty ranges and unknown users say no messages", async (note) => {
  const state = await scenario(fresh());
  let ok = true;
  // m1 and m2 are inside; the call at exactly 11:00Z (m3) is excluded by the exclusive upper bound.
  ok = checkWhy(note, "u2 09:00-11:00", await why(state, "u2", "2026-09-04T09:00:00Z", "2026-09-04T11:00:00Z"), {
    delivered: 2,
    blocked: [],
    byRule: {},
    verdictHas: ["delivered"],
  }) && ok;
  // m3 starts exactly at the inclusive lower bound; m6 at 04:00Z is excluded by the exclusive upper bound.
  // Two quiet-hours blocks against one daily-cap block, so the verdict must name quiet hours.
  ok = checkWhy(note, "u2 11:00Z-04:00Z", await why(state, "u2", "2026-09-04T11:00:00Z", "2026-09-05T04:00:00Z"), {
    delivered: 0,
    blocked: [
      { messageId: "m3", at: "2026-09-04T11:00:00Z", rule: "dailyCap" },
      { messageId: "m4", at: "2026-09-04T19:30:00Z", rule: "quietHours" },
      { messageId: "m5", at: "2026-09-05T03:00:00Z", rule: "quietHours" },
    ],
    byRule: { dailyCap: 1, quietHours: 2 },
    verdictHas: ["nothing was delivered", "quiet hours"],
  }) && ok;
  ok = checkWhy(note, "u2 empty range", await why(state, "u2", "2026-09-06T00:00:00Z", "2026-09-07T00:00:00Z"), {
    delivered: 0,
    blocked: [],
    byRule: {},
    verdictHas: ["no messages"],
  }) && ok;
  ok = checkWhy(note, "unknown user", await why(state, "nobody", ...WHOLE), {
    delivered: 0,
    blocked: [],
    byRule: {},
    verdictHas: ["no messages"],
  }) && ok;
  return ok;
});

await r.crit("4 persistence: records written by separate processes are read back by later processes, and reading changes nothing", async (note) => {
  const state = fresh();
  const a = await dv(state, "u2", true, "m1", "2026-09-04T09:00:00Z");
  const b = await dv(state, "u2", true, "m2", "2026-09-04T10:00:00Z");
  const c = await dv(state, "u2", true, "m3", "2026-09-04T11:00:00Z");
  let ok = true;
  if (!a || a.delivered !== true || !b || b.delivered !== true) {
    ok = false;
    note(`first two sends: ${JSON.stringify([a, b])}`);
  }
  if (!c || c.delivered !== false || c.rule !== "dailyCap") {
    ok = false;
    note(`third send seen by a new process: ${JSON.stringify(c)}, expected dailyCap`);
  }
  const want = {
    delivered: 2,
    blocked: [{ messageId: "m3", at: "2026-09-04T11:00:00Z", rule: "dailyCap" }],
    byRule: { dailyCap: 1 },
    verdictHas: ["delivered"],
  };
  const w1 = await why(state, "u2", ...WHOLE);
  const w2 = await why(state, "u2", ...WHOLE);
  ok = checkWhy(note, "whyNothing from a fourth process", w1, want) && ok;
  ok = checkWhy(note, "whyNothing from a fifth process", w2, want) && ok;
  if (JSON.stringify(w1) !== JSON.stringify(w2)) {
    ok = false;
    note("two reads of the same range differ");
  }
  return ok;
});

await r.crit("5 concurrency: 2 processes x 12 concurrent calls for each of 5 users at one instant: exactly 2 delivered per user, no lost or duplicated record", async (note) => {
  const state = fresh();
  const USERS = ["c1", "c2", "c3", "c4", "c5"];
  const NOW = "2026-09-04T09:00:00Z";
  const plans = [0, 1].map((p) => {
    const plan = [];
    for (const u of USERS) {
      for (let k = 0; k < 12; k++) {
        plan.push({ fn: "deliver", args: { user: { id: u, timezone: IST, consent: true }, message: { id: `p${p}-${u}-${k}` }, now: NOW } });
      }
    }
    return plan;
  });
  const results = await Promise.all(plans.map((plan) => run(dir, state, plan, true)));
  let ok = true;
  const delivered = Object.fromEntries(USERS.map((u) => [u, []]));
  results.forEach((res, p) => {
    if (!Array.isArray(res) || res.length !== plans[p].length) {
      ok = false;
      note(`process ${p} gave no complete result array`);
      return;
    }
    plans[p].forEach((item, idx) => {
      const got = res[idx];
      const u = item.args.user.id;
      if (got && got.delivered === true && (got.rule ?? null) === null) delivered[u].push(item.args.message.id);
      else if (!(got && got.delivered === false && got.rule === "dailyCap")) {
        ok = false;
        note(`${item.args.message.id}: ${JSON.stringify(got)}`);
      }
    });
  });
  const expectedIds = new Set();
  for (let p = 0; p < 2; p++) for (const u of USERS) for (let k = 0; k < 12; k++) expectedIds.add(`p${p}-${u}-${k}`);
  for (const u of USERS) {
    const w = await why(state, u, "2026-09-04T00:00:00Z", "2026-09-05T00:00:00Z");
    if (!w || w.error || !Array.isArray(w.blocked)) {
      ok = false;
      note(`${u}: no whyNothing answer`);
      continue;
    }
    if (delivered[u].length !== 2) {
      ok = false;
      note(`${u}: ${delivered[u].length} delivered results, expected 2`);
    }
    if (w.delivered !== 2) {
      ok = false;
      note(`${u}: whyNothing delivered ${w.delivered}, expected 2`);
    }
    if (w.blocked.length !== 22 || (w.byRule && w.byRule.dailyCap) !== 22) {
      ok = false;
      note(`${u}: ${w.blocked.length} blocked, byRule ${JSON.stringify(w.byRule)}; expected 22 and dailyCap 22`);
    }
    const ids = [...delivered[u], ...w.blocked.map((b) => b.messageId)];
    if (new Set(ids).size !== ids.length) {
      ok = false;
      note(`${u}: duplicated message ids`);
    }
    const expectedForUser = [...expectedIds].filter((id) => id.includes(`-${u}-`));
    if (ids.length !== 24 || expectedForUser.some((id) => !ids.includes(id))) {
      ok = false;
      note(`${u}: recorded ids do not match the 24 sent ids`);
    }
  }
  return ok;
});

await r.crit("6 local day: the cap counts one local calendar day per user, and the New York day is not the UTC date", async (note) => {
  const state = fresh();
  // Istanbul (UTC+3). Midnight is quiet hours, so the reset is visible at 07:00 local (04:00Z) and not before.
  const k = [
    ["k1", "2026-09-04T06:00:00Z", null],
    ["k2", "2026-09-04T18:00:00Z", null],
    ["k3", "2026-09-04T18:30:00Z", "dailyCap"],
    ["k4", "2026-09-04T21:00:00Z", "quietHours"],
    ["k5", "2026-09-05T04:00:00Z", null],
    ["k6", "2026-09-05T04:30:00Z", null],
    ["k7", "2026-09-05T05:00:00Z", "dailyCap"],
  ];
  // New York (UTC-4 on these dates). 01:00Z on 5 Sep is still 4 Sep locally, so the cap applies although the UTC date changed.
  const n = [
    ["n1", "2026-09-04T12:00:00Z", null],
    ["n2", "2026-09-04T13:00:00Z", null],
    ["n3", "2026-09-05T01:00:00Z", "dailyCap"],
    ["n4", "2026-09-05T11:30:00Z", null],
  ];
  let ok = true;
  for (const [id, at, want] of k) {
    const got = await dv(state, "k", true, id, at);
    if (!got || got.delivered !== (want === null) || (got.rule ?? null) !== want) {
      ok = false;
      note(`Istanbul ${id} at ${at}: got ${JSON.stringify(got)}, expected ${want ?? "delivered"}`);
    }
  }
  for (const [id, at, want] of n) {
    const got = await dv(state, "n", true, id, at, NY);
    if (!got || got.delivered !== (want === null) || (got.rule ?? null) !== want) {
      ok = false;
      note(`New York ${id} at ${at}: got ${JSON.stringify(got)}, expected ${want ?? "delivered"}`);
    }
  }
  return ok;
});

for (const d of made) rmSync(d, { recursive: true, force: true });
r.print();
