import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { PostgresStore } from "../dist/src/stores.js";
import { storeContract } from "../dist/src/store-contract.js";

const connectionString = process.env.PROACTIVE_GATE_POSTGRES_URL;

let schemaNumber = 0;

storeContract(
  "PostgresStore",
  async (clock) => {
    if (!connectionString) throw new Error("PROACTIVE_GATE_POSTGRES_URL is not set");
    const schema = `s${++schemaNumber}_${Date.now().toString(36)}`;
    const admin = new Pool({ connectionString, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.end();
    const pool = new Pool({ connectionString, max: 10, options: `-c search_path=${schema}` });
    const store = new PostgresStore({ query: (text, params) => pool.query(text, params ? [...params] : undefined) }, clock);
    return {
      store,
      teardown: async () => {
        await pool.end();
        const cleanup = new Pool({ connectionString, max: 1 });
        await cleanup.query(`DROP SCHEMA ${schema} CASCADE`);
        await cleanup.end();
      },
    };
  },
  { skip: connectionString ? undefined : "PROACTIVE_GATE_POSTGRES_URL is not set" },
);

test("PostgresStore: concurrent construction is race-safe", { skip: connectionString ? undefined : "PROACTIVE_GATE_POSTGRES_URL is not set" }, async () => {
  const pool = new Pool({ connectionString, max: 10 });
  const schema = `concurrent_${Date.now().toString(36)}`;
  await pool.query(`CREATE SCHEMA ${schema}`);
  const scoped = new Pool({ connectionString, max: 10, options: `-c search_path=${schema}` });
  try {
    for (let round = 0; round < 15; round++) {
      const stores = Array.from({ length: 8 }, () => new PostgresStore({ query: (text, params) => scoped.query(text, params ? [...params] : undefined) }));
      await Promise.all(stores.map((store) => store.get("missing")));
    }
  } finally {
    await scoped.end();
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
  }
});

test("PostgresStore: expired rows are swept on writes", { skip: connectionString ? undefined : "PROACTIVE_GATE_POSTGRES_URL is not set" }, async () => {
  let now = 0;
  const pool = new Pool({ connectionString, max: 2 });
  const schema = `sweep_${Date.now().toString(36)}`;
  await pool.query(`CREATE SCHEMA ${schema}`);
  const scoped = new Pool({ connectionString, max: 2, options: `-c search_path=${schema}` });
  try {
    const store = new PostgresStore({ query: (text, params) => scoped.query(text, params ? [...params] : undefined) }, () => now);
    await store.set("stale", "value", 1);
    now = 1000;
    await store.set("live", "value");
    const count = await scoped.query("SELECT COUNT(*)::int AS count FROM proactive_gate_store");
    assert.equal(count.rows[0].count, 1);
  } finally {
    await scoped.end();
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
  }
});
