import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Deterministic counterpart of sqlite-multiprocess.test.mjs. The test process holds the write lock with
// BEGIN IMMEDIATE, a child process builds a SqliteStore on the same file and calls incr, and the lock is
// released 700 ms after the child reports READY. The child must wait for the lock and return 1.

const dist = fileURLToPath(new URL("../dist/src/index.js", import.meta.url));
const sqliteAvailable = Number(process.versions.node.split(".")[0]) >= 22;

// The child prints READY once its store is open, then calls incr. It prints one JSON line with the value,
// the time incr took, and the busy timeout of the store's own connection and of a fresh second connection.
const child = `
const [dbPath, distPath] = process.argv.slice(1);
const { SqliteStore } = await import(distPath);
const { DatabaseSync } = await import("node:sqlite");
const store = new SqliteStore(dbPath);
console.log("READY");
const started = Date.now();
const value = await store.incr("lock-wait-key", 3600);
const waited = Date.now() - started;
const storeTimeout = store.database.prepare("PRAGMA busy_timeout").get().timeout;
const second = new DatabaseSync(dbPath);
const report = {
  value,
  waited,
  storeBusyTimeout: storeTimeout,
  secondJournalMode: second.prepare("PRAGMA journal_mode").get().journal_mode,
  secondBusyTimeout: second.prepare("PRAGMA busy_timeout").get().timeout,
};
console.log(JSON.stringify(report));
second.close();
store.close();
`;

test("a write waits for another process's lock instead of failing with database is locked", { skip: sqliteAvailable ? false : "node:sqlite needs Node.js 22.5 or newer" }, async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const { SqliteStore } = await import(dist);
  const directory = mkdtempSync(join(tmpdir(), "proactive-gate-lock-"));
  const path = join(directory, "store.sqlite");
  try {
    // A fresh file, created the way the library creates it.
    new SqliteStore(path).close();
    const holder = new DatabaseSync(path);
    const journalMode = holder.prepare("PRAGMA journal_mode").get().journal_mode;
    t.diagnostic(`fresh file journal_mode=${journalMode}`);
    assert.equal(journalMode, "wal");

    holder.exec("BEGIN IMMEDIATE");
    const proc = spawn(process.execPath, ["--input-type=module", "-e", child, path, dist], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stderr.on("data", (chunk) => (stderr += chunk));
    const ready = new Promise((resolve) => {
      proc.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (stdout.includes("READY")) resolve();
      });
    });
    const exited = new Promise((resolve) => proc.on("close", (code) => resolve(code)));

    await ready;
    await new Promise((resolve) => setTimeout(resolve, 700));
    holder.exec("COMMIT");
    holder.close();
    const code = await exited;

    assert.equal(code, 0, `child must not crash: ${stderr}`);
    assert.doesNotMatch(stderr, /database is locked/);
    const report = JSON.parse(stdout.trim().split("\n").at(-1));
    t.diagnostic(`child report: ${JSON.stringify(report)}`);
    assert.equal(report.value, 1, "the child incremented after the lock was released");
    assert.ok(report.waited >= 500, `the child waited for the lock (waited ${report.waited} ms)`);
    assert.ok(report.storeBusyTimeout >= 30000, "the store's own connection waits at least 30 seconds");
    assert.equal(report.secondJournalMode, "wal", "the file is in WAL mode, which is a property of the file");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
