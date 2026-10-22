import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Many processes on one machine share one SqliteStore file. Each one evaluates and commits a candidate
// for the same user at the same instant. A dailyBudget of 3 must allow exactly 3 commits in total.

const dist = fileURLToPath(new URL("../dist/src/index.js", import.meta.url));
const sqliteAvailable = Number(process.versions.node.split(".")[0]) >= 22;
const PROCESSES = 30;
const LIMIT = 3;
const ROUNDS = 3;

// The child waits for a shared start instant so the processes contend at once, then opens the file,
// builds the gate, evaluates and commits one candidate. It prints one line: COMMIT true|false.
const child = `
const [dbPath, startAt, id, distPath] = process.argv.slice(1);
const wait = Number(startAt) - Date.now();
if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
const { createGate, SqliteStore } = await import(distPath);
const store = new SqliteStore(dbPath);
const gate = createGate({
  policy: { specVersion: "1.0.0", checks: [{ id: "consent" }, { id: "dailyBudget", limit: ${LIMIT} }] },
  store,
});
const user = { id: "u1", consent: true, timezone: "UTC" };
const candidate = { id: "c-" + id, type: "reminder", priority: "normal", surfaces: ["push"] };
const now = new Date("2026-10-21T10:00:00Z");
const decision = await gate.evaluate({ user, candidate, now });
const committed = await gate.commit(decision, { user, candidate, now });
console.log("COMMIT " + committed);
store.close();
`;

function runChild(args) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, ["--input-type=module", "-e", child, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => (stdout += chunk));
    proc.stderr.on("data", (chunk) => (stderr += chunk));
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function burst(path) {
  const startAt = String(Date.now() + 1500);
  const runs = await Promise.all(
    Array.from({ length: PROCESSES }, (_, i) => runChild([path, startAt, String(i), dist])),
  );
  const crashed = runs.filter((run) => run.code !== 0);
  const trues = runs.filter((run) => run.stdout.includes("COMMIT true")).length;
  return { crashed, trues };
}

test("thirty processes on one sqlite file commit exactly the daily budget, three times over", { skip: sqliteAvailable ? false : "node:sqlite needs Node.js 22.5 or newer" }, async () => {
  for (let round = 1; round <= ROUNDS; round++) {
    const directory = mkdtempSync(join(tmpdir(), "proactive-gate-mp-"));
    try {
      const { crashed, trues } = await burst(join(directory, "store.sqlite"));
      assert.deepEqual(
        crashed.map((run) => run.stderr.split("\n").find((line) => /Error/.test(line)) ?? "no error line"),
        [],
        `round ${round}: no child may crash`,
      );
      assert.equal(trues, LIMIT, `round ${round}: exactly the daily budget commits`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
