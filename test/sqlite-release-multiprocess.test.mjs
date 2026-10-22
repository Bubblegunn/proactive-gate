import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Client API (SPEC 10.1). Thirty processes commit one candidate each against one SqliteStore file with a daily budget
// of three. Then the committed decisions are released by other processes. The counter must return to zero, and the
// same burst must then commit exactly the budget again.

const dist = fileURLToPath(new URL("../dist/src/index.js", import.meta.url));
const sqliteAvailable = Number(process.versions.node.split(".")[0]) >= 22;
const PROCESSES = 30;
const LIMIT = 3;
const NOW = "2026-10-21T10:00:00Z";

// argv: dbPath, startAt, mode ("commit" | "release"), id or decision JSON, distPath.
const child = `
const [dbPath, startAt, mode, payload, distPath] = process.argv.slice(1);
const wait = Number(startAt) - Date.now();
if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
const { createGate, checks, SqliteStore } = await import(distPath);
const store = new SqliteStore(dbPath);
const gate = createGate({ checks: [checks.dailyBudget({ limit: ${LIMIT} })], store });
const user = { id: "u1", consent: true, timezone: "UTC" };
const now = new Date("${NOW}");
if (mode === "commit") {
  const candidate = { id: "c-" + payload, type: "reminder", priority: "normal", surfaces: ["push"] };
  const decision = await gate.evaluate({ user, candidate, now });
  const committed = await gate.commit(decision, { user, candidate, now });
  console.log("COMMIT " + committed + " " + JSON.stringify({ decision, candidate }));
} else {
  const { decision, candidate } = JSON.parse(payload);
  const released = await gate.release(decision, { user, candidate, now });
  console.log("RELEASE " + released);
}
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

const firstErrorLine = (run) => run.stderr.split("\n").find((line) => /Error/.test(line)) ?? "no error line";

test("thirty processes commit the budget, other processes release it, and the next burst commits it again", { skip: sqliteAvailable ? false : "node:sqlite needs Node.js 22.5 or newer" }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "proactive-gate-release-"));
  const path = join(directory, "store.sqlite");
  try {
    const burst = async (round) => {
      const startAt = String(Date.now() + 1500);
      const runs = await Promise.all(Array.from({ length: PROCESSES }, (_, i) => runChild([path, startAt, "commit", `${round}-${i}`, dist])));
      assert.deepEqual(runs.filter((run) => run.code !== 0).map(firstErrorLine), [], `round ${round}: no commit child may crash`);
      return runs.map((run) => run.stdout.match(/^COMMIT (true|false) (.*)$/m)).filter((m) => m && m[1] === "true").map((m) => JSON.parse(m[2]));
    };
    const releaseAll = async (decisions) => {
      const startAt = String(Date.now() + 500);
      const runs = await Promise.all(decisions.map((payload) => runChild([path, startAt, "release", JSON.stringify(payload), dist])));
      assert.deepEqual(runs.filter((run) => run.code !== 0).map(firstErrorLine), [], "no release child may crash");
      return runs.filter((run) => run.stdout.includes("RELEASE true")).length;
    };

    const first = await burst("a");
    assert.equal(first.length, LIMIT, "the first burst commits exactly the budget");
    assert.equal(await releaseAll(first), first.length, "every committed decision releases once, in its own process");

    const second = await burst("b");
    assert.equal(second.length, LIMIT, "after the release, the next burst commits exactly the budget again");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
