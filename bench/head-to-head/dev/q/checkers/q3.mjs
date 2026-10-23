import { load, Report } from "./lib.mjs";
import { runProc } from "./procz.mjs";
import { mkdtempSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const dir = resolve(process.argv[2]);
const r = new Report();
const newState = () => { const parent = mkdtempSync(join(tmpdir(), "q3-")); const s = join(parent, "state"); return { parent, s }; };
const D = (iso) => ({ $date: iso });
const res = (id, kind, iso) => ({ fn: "tryReserveEmail", args: [{ userId: id, kind }, D(iso)] });
const unsub = (id, iso) => ({ fn: "recordUnsubscribe", args: [id, D(iso)] });
const nAllowed = (arr) => arr.filter((x) => x && x.allowed === true).length;
const T0 = "2026-05-04T10:00:00Z";

await r.crit("1 concurrent requests inside one process cannot exceed 2 marketing emails", async (why) => {
  const { s } = newState();
  const out = await runProc(dir, s, Array.from({ length: 8 }, () => res("u1", "marketing", T0)), true);
  const n = nAllowed(out);
  if (n !== 2) { why(`allowed ${n} of 8: ` + JSON.stringify(out).slice(0, 200)); return false; }
  return true;
});

await r.crit("2 state is shared between processes and survives a restart", async (why) => {
  const { s } = newState();
  const a = await runProc(dir, s, [res("u1", "marketing", T0), res("u1", "marketing", "2026-05-04T10:05:00Z")]);
  if (nAllowed(a) !== 2) { why("first process: " + JSON.stringify(a)); return false; }
  const b = await runProc(dir, s, [res("u1", "marketing", "2026-05-04T10:10:00Z")]);
  if (b[0] && b[0].allowed !== false) { why("third email allowed from a fresh process"); return false; }
  return !!b[0] && !b[0].error;
});

await r.crit("3 four processes at the same time still allow exactly 2 per user", async (why) => {
  const { s } = newState();
  const plan = [res("u1", "marketing", T0), res("u2", "marketing", T0), res("u1", "marketing", T0), res("u2", "marketing", T0), res("u1", "marketing", T0), res("u2", "marketing", T0)];
  const outs = await Promise.all([1, 2, 3, 4].map(() => runProc(dir, s, plan, true)));
  let u1 = 0, u2 = 0;
  for (const o of outs) o.forEach((x, i) => { if (x && x.allowed === true) (i % 2 === 0 ? u1++ : u2++); });
  if (u1 !== 2 || u2 !== 2) { why(`u1 allowed ${u1}, u2 allowed ${u2}`); return false; }
  return true;
});

await r.crit("4 unsubscribe in one process stops marketing in another, forever, but not transactional", async (why) => {
  const { s } = newState();
  await runProc(dir, s, [unsub("u1", T0)]);
  const out = await runProc(dir, s, [res("u1", "marketing", "2026-05-04T10:01:00Z"), res("u1", "marketing", "2028-09-01T10:00:00Z"), res("u1", "transactional", "2026-05-04T10:02:00Z"), res("u2", "marketing", "2026-05-04T10:02:00Z")]);
  if (out[0].allowed !== false || out[1].allowed !== false) { why("marketing allowed after unsubscribe " + JSON.stringify(out)); return false; }
  if (out[2].allowed !== true) { why("transactional blocked " + JSON.stringify(out[2])); return false; }
  if (out[3].allowed !== true) { why("other user blocked"); return false; }
  if (out[0].reason === "ok" || !out[0].reason) { why("no reason"); return false; }
  return true;
});

await r.crit("5 the 24-hour window rolls: expiry frees one slot at a time, blocked tries record nothing", async (why) => {
  const { s } = newState();
  const a = await runProc(dir, s, [res("u1", "marketing", T0), res("u1", "marketing", "2026-05-04T11:00:00Z"), res("u1", "marketing", "2026-05-04T13:00:00Z"), res("u1", "marketing", "2026-05-04T22:00:00Z")]);
  if (!(a[0].allowed && a[1].allowed && !a[2].allowed && !a[3].allowed)) { why("day-one results " + JSON.stringify(a.map((x) => x.allowed))); return false; }
  const b = await runProc(dir, s, [res("u1", "marketing", "2026-05-05T10:01:00Z"), res("u1", "marketing", "2026-05-05T10:02:00Z"), res("u1", "marketing", "2026-05-05T11:01:00Z")]);
  if (!(b[0].allowed === true && b[1].allowed === false && b[2].allowed === true)) { why("day-two results " + JSON.stringify(b.map((x) => x.allowed))); return false; }
  return true;
});

await r.crit("6 odd user ids neither collide, fail, nor write outside STATE_DIR", async (why) => {
  const { parent, s } = newState();
  const ids = ["a/b", "a_b", "../escape", "A", "a", "ü", "x".repeat(300), "con", "a b", "..", "a\\b", "%2e"];
  const plan = [];
  for (const id of ids) for (let k = 0; k < 3; k++) plan.push(res(id, "marketing", T0));
  const out = await runProc(dir, s, plan);
  for (let i = 0; i < ids.length; i++) {
    const g = out.slice(i * 3, i * 3 + 3);
    if (g.some((x) => x && x.error)) { why(`error for id #${i}: ` + g.find((x) => x.error).error); return false; }
    if (nAllowed(g) !== 2) { why(`id #${i} allowed ${nAllowed(g)} of 3`); return false; }
  }
  const left = readdirSync(parent).filter((n) => n !== "state");
  if (left.length) { why("files outside STATE_DIR: " + left); return false; }
  return true;
});
r.print();
