import { Report } from "./lib.mjs";
import { runProc } from "./procz.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = process.argv[2];
const r = new Report();
const NOW = { $date: "2026-06-01T10:00:00Z" };
const tmp = () => mkdtempSync(join(tmpdir(), "g3-"));
const unsub = (e) => ({ fn: "unsubscribe", args: [e] });
const resub = (e) => ({ fn: "resubscribe", args: [e] });
const may = (e, k = "marketing") => ({ fn: "mayEmail", args: [e, k, NOW] });

await r.crit("1 an unsubscribe recorded by one worker stops marketing mail in another", async (why) => {
  const s = tmp();
  await runProc(dir, s, [unsub("ann@example.com")]);
  const [a, b] = await runProc(dir, s, [may("ann@example.com"), may("bob@example.com")]);
  why(JSON.stringify([a, b]));
  return a.allowed === false && typeof a.reason === "string" && a.reason.length > 3 && b.allowed === true;
});
await r.crit("2 capitalisation and stray spaces do not get around an unsubscribe", async (why) => {
  const s = tmp();
  await runProc(dir, s, [unsub("  Jane.Doe@Example.COM ")]);
  const [a, b, c] = await runProc(dir, s, [may("jane.doe@example.com"), may(" JANE.DOE@EXAMPLE.com\n"), may("jane.doe@example.org")]);
  await runProc(dir, s, [unsub("carl@example.com")]);
  const [d] = await runProc(dir, s, [may("CARL@example.com ")]);
  why(JSON.stringify([a, b, c, d]));
  return a.allowed === false && b.allowed === false && c.allowed === true && d.allowed === false;
});
await r.crit("3 receipts and password mails still go to an unsubscribed address", async (why) => {
  const s = tmp();
  await runProc(dir, s, [unsub("dee@example.com")]);
  const [a, b, c] = await runProc(dir, s, [may("dee@example.com", "receipt"), may("dee@example.com", "marketing"), may("eve@example.com", "receipt")]);
  why(JSON.stringify([a, b, c]));
  return a.allowed === true && b.allowed === false && c.allowed === true;
});
await r.crit("4 unsubscribes recorded at the same moment by several workers are all kept", async (why) => {
  const s = tmp();
  const addrs = (w) => Array.from({ length: 15 }, (_, i) => `w${w}-${i}@example.com`);
  await Promise.all([0, 1, 2, 3].map((w) => runProc(dir, s, addrs(w).map(unsub), w % 2 === 1)));
  const all = [0, 1, 2, 3].flatMap(addrs);
  const res = await runProc(dir, s, all.map((e) => may(e)));
  const lost = all.filter((e, i) => res[i].allowed !== false);
  why("still mailable: " + lost.length + " e.g. " + lost.slice(0, 3));
  return lost.length === 0;
});
await r.crit("5 resubscribe lifts the block, for that address only", async (why) => {
  const s = tmp();
  await runProc(dir, s, [unsub("fay@example.com"), unsub("gus@example.com")]);
  await runProc(dir, s, [resub(" Fay@example.com")]);
  const [a, b] = await runProc(dir, s, [may("fay@example.com"), may("gus@example.com")]);
  why(JSON.stringify([a, b]));
  return a.allowed === true && b.allowed === false;
});
await r.crit("6 a state directory that does not exist yet is created and survives restarts", async (why) => {
  const s = join(tmp(), "deep", "er", "state");
  const [x] = await runProc(dir, s, [may("hal@example.com")]);
  await runProc(dir, s, [unsub("hal@example.com")]);
  const [a] = await runProc(dir, s, [may("hal@example.com")]);
  why(JSON.stringify([x, a]));
  return x.allowed === true && a.allowed === false;
});
r.print();
