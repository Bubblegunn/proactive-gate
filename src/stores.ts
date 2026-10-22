import type { DatabaseSync } from "node:sqlite";
import type { Store, SyncStore } from "./types.js";

/** In-process store. Correct for one instance, wrong the moment you scale out. It also has the synchronous methods `gate.evaluateSync` needs. */
export class MemoryStore implements SyncStore {
  private readonly data = new Map<
    string,
    { value: string; expiresAt: number | null }
  >();

  constructor(private readonly clock: () => number = () => Date.now()) {}

  private live(
    key: string,
  ): { value: string; expiresAt: number | null } | undefined {
    const entry = this.data.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= this.clock()) {
      this.data.delete(key);
      return undefined;
    }
    return entry;
  }

  getSync(key: string): string | null {
    return this.live(key)?.value ?? null;
  }

  setSync(key: string, value: string, ttlSeconds?: number): void {
    this.data.set(key, {
      value,
      expiresAt: ttlSeconds ? this.clock() + ttlSeconds * 1000 : null,
    });
  }

  /** INCRBY semantics. The TTL is attached only when this call creates the key, so an existing expiry is kept. */
  incrBySync(key: string, delta: number, ttlSeconds?: number): number {
    const current = this.live(key);
    const next = (current ? Number(current.value) : 0) + delta;
    const expiresAt = current
      ? current.expiresAt
      : ttlSeconds
        ? this.clock() + ttlSeconds * 1000
        : null;
    this.data.set(key, { value: String(next), expiresAt });
    return next;
  }

  incrSync(key: string, ttlSeconds?: number): number {
    return this.incrBySync(key, 1, ttlSeconds);
  }

  delSync(key: string): void {
    this.data.delete(key);
  }

  async get(key: string): Promise<string | null> {
    return this.getSync(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    this.setSync(key, value, ttlSeconds);
  }

  async incr(key: string, ttlSeconds?: number): Promise<number> {
    return this.incrSync(key, ttlSeconds);
  }

  async incrBy(key: string, delta: number, ttlSeconds?: number): Promise<number> {
    return this.incrBySync(key, delta, ttlSeconds);
  }

  async del(key: string): Promise<void> {
    this.delSync(key);
  }

  /** Test helper. */
  size(): number {
    return this.data.size;
  }
}

/**
 * The subset of a Redis client the gate needs. ioredis satisfies it directly;
 * node-redis names are upper-case or take options objects, so pass a small
 * adapter.
 *
 * `eval` is optional so that adapters written before it existed keep working.
 * With it, `incr` runs INCR and EXPIRE as one server-side script, so a counter
 * can never be left without a TTL. Without it, `incr` falls back to INCR then a
 * separate EXPIRE, and a failure between those two round trips leaves a counter
 * that never expires. The signature is ioredis's: `eval(script, numKeys, ...keysThenArgs)`.
 */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: any[]): Promise<unknown>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  eval?(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  /**
   * Optional. Needed by `RedisStore.incrBy` when the client has no `eval`. Caveat: without `eval` the TTL is set by a
   * second command when `incrby` returns exactly `delta`, which is also what a counter sitting at 0 (left by a release)
   * returns after one increment. So that increment re-attaches the TTL, extending the key's life. The `eval` path has
   * no such caveat: it checks whether the key existed before the call.
   */
  incrby?(key: string, delta: number): Promise<number>;
}

/**
 * INCR, and EXPIRE when the increment created the key. Redis runs a script
 * without interleaving other commands, so the TTL is attached in the same step
 * that creates the counter. The Python RedisStore runs the same script.
 */
const REDIS_INCR_SCRIPT =
  "local n = redis.call('INCR', KEYS[1]) if n == 1 and tonumber(ARGV[1]) > 0 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end return n";

/**
 * INCRBY by ARGV[2], and EXPIRE with ARGV[1] when the key did not exist before the call. The existence test runs
 * in the same script, so the TTL is attached to a key created by this call and to no other.
 */
const REDIS_INCRBY_SCRIPT =
  "local existed = redis.call('EXISTS', KEYS[1]) local n = redis.call('INCRBY', KEYS[1], ARGV[2]) if existed == 0 and tonumber(ARGV[1]) > 0 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end return n";

/**
 * Redis-backed store. `incr` is atomic on the server, which is what makes the
 * daily budget safe across many instances; the TTL is attached on the first
 * increment so a day's counter disappears on its own. With a client that has
 * `eval` (ioredis does), the increment and the TTL are one script.
 */
export class RedisStore implements Store {
  constructor(private readonly client: RedisLike) {}

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) await this.client.set(key, value, "EX", ttlSeconds);
    else await this.client.set(key, value);
  }

  async incr(key: string, ttlSeconds?: number): Promise<number> {
    if (this.client.eval)
      return Number(
        await this.client.eval(REDIS_INCR_SCRIPT, 1, key, ttlSeconds ?? 0),
      );
    const next = await this.client.incr(key);
    if (next === 1 && ttlSeconds) await this.client.expire(key, ttlSeconds);
    return next;
  }

  /**
   * INCRBY with a TTL attached when the call creates the key. With an `eval` client this is one script; with only
   * `incrby` the TTL is a second command, as `incr` does without `eval`.
   */
  async incrBy(key: string, delta: number, ttlSeconds?: number): Promise<number> {
    if (this.client.eval)
      return Number(
        await this.client.eval(REDIS_INCRBY_SCRIPT, 1, key, ttlSeconds ?? 0, delta),
      );
    if (!this.client.incrby)
      throw new Error("RedisStore.incrBy needs a client with eval or incrby");
    const next = await this.client.incrby(key, delta);
    if (next === delta && ttlSeconds) await this.client.expire(key, ttlSeconds);
    return next;
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }
}

/**
 * The query surface needed by PostgresStore. pg Pool and Client implement it
 * directly; other Postgres clients can adapt their query method to this shape.
 */
export interface PostgresLike {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
}

export class PostgresStore implements Store {
  private readonly ready: Promise<void>;
  private readonly clock: () => number;
  private readyError: unknown = undefined;

  constructor(
    private readonly client: PostgresLike,
    clock: () => number = () => Date.now(),
  ) {
    this.clock = clock;
    this.ready = this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      await this.client.query(
        // The partial index keeps the write sweep proportional to the dead rows rather than to the
        // table, the same reason SqliteStore carries one. Without it every set and every incr
        // scans for expired rows.
        "DO $$ BEGIN PERFORM pg_advisory_xact_lock(hashtext('proactive_gate_store')); CREATE TABLE IF NOT EXISTS proactive_gate_store (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, expires_at BIGINT); CREATE INDEX IF NOT EXISTS proactive_gate_store_expires_at ON proactive_gate_store (expires_at) WHERE expires_at IS NOT NULL; COMMENT ON TABLE proactive_gate_store IS 'Expired rows remain until read, write sweep, or delete.'; END $$",
      );
    } catch (error) {
      this.readyError = error;
    }
  }

  private async waitReady(): Promise<void> {
    await this.ready;
    if (this.readyError) throw this.readyError;
  }

  private async sweep(now: number): Promise<void> {
    await this.client.query(
      "DELETE FROM proactive_gate_store WHERE expires_at IS NOT NULL AND expires_at <= $1",
      [now],
    );
  }

  async get(key: string): Promise<string | null> {
    await this.waitReady();
    const now = this.clock();
    const rows = await this.client.query<{
      value: string;
      expires_at: string | null;
    }>("SELECT value, expires_at FROM proactive_gate_store WHERE key = $1", [
      key,
    ]);
    const row = rows.rows[0];
    if (!row) return null;
    if (row.expires_at !== null && Number(row.expires_at) <= now) {
      await this.client.query(
        "DELETE FROM proactive_gate_store WHERE key = $1",
        [key],
      );
      return null;
    }
    return row.value;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    await this.waitReady();
    const now = this.clock();
    const expiresAt = ttlSeconds ? now + ttlSeconds * 1000 : null;
    await this.sweep(now);
    await this.client.query(
      "INSERT INTO proactive_gate_store (key, value, expires_at) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at",
      [key, value, expiresAt],
    );
  }

  async incr(key: string, ttlSeconds?: number): Promise<number> {
    await this.waitReady();
    const now = this.clock();
    const expiresAt = ttlSeconds ? now + ttlSeconds * 1000 : null;
    await this.sweep(now);
    const rows = await this.client.query<{ value: string }>(
      "INSERT INTO proactive_gate_store (key, value, expires_at) VALUES ($1, '1', $2) ON CONFLICT (key) DO UPDATE SET value = CASE WHEN proactive_gate_store.expires_at IS NOT NULL AND proactive_gate_store.expires_at <= $3 THEN '1' ELSE (CAST(proactive_gate_store.value AS BIGINT) + 1)::TEXT END, expires_at = CASE WHEN proactive_gate_store.expires_at IS NOT NULL AND proactive_gate_store.expires_at <= $3 THEN EXCLUDED.expires_at ELSE proactive_gate_store.expires_at END RETURNING value",
      [key, expiresAt, now],
    );
    return Number(rows.rows[0]!.value);
  }

  async incrBy(key: string, delta: number, ttlSeconds?: number): Promise<number> {
    await this.waitReady();
    const now = this.clock();
    const expiresAt = ttlSeconds ? now + ttlSeconds * 1000 : null;
    await this.sweep(now);
    const rows = await this.client.query<{ value: string }>(
      "INSERT INTO proactive_gate_store (key, value, expires_at) VALUES ($1, CAST($2::BIGINT AS TEXT), $3) ON CONFLICT (key) DO UPDATE SET value = CASE WHEN proactive_gate_store.expires_at IS NOT NULL AND proactive_gate_store.expires_at <= $4 THEN CAST($2::BIGINT AS TEXT) ELSE (CAST(proactive_gate_store.value AS BIGINT) + $2::BIGINT)::TEXT END, expires_at = CASE WHEN proactive_gate_store.expires_at IS NOT NULL AND proactive_gate_store.expires_at <= $4 THEN EXCLUDED.expires_at ELSE proactive_gate_store.expires_at END RETURNING value",
      [key, delta, expiresAt, now],
    );
    return Number(rows.rows[0]!.value);
  }

  async del(key: string): Promise<void> {
    await this.waitReady();
    await this.client.query("DELETE FROM proactive_gate_store WHERE key = $1", [
      key,
    ]);
  }
}

function tryPragma(database: DatabaseSync, sql: string): void {
  try {
    database.exec(sql);
  } catch {
    // The database keeps its default setting.
  }
}

/** Blocks the thread for a few milliseconds. The store constructor is synchronous, so a retry cannot await. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Store backed by a single SQLite file (node:sqlite, Node 22.5 or newer).
 *
 * Safe for several processes on one machine that share the file: a busy timeout of 30 seconds makes a
 * contended statement wait instead of failing with "database is locked", and the database runs in WAL
 * mode, so readers do not block the writer. WAL creates a `-wal` and a `-shm` file next to the database
 * while it is open; keep them with the database and do not delete them by hand. Schema creation is
 * retried a few times when another process holds the file at first open.
 */
export class SqliteStore implements Store {
  private readonly database: DatabaseSync;
  private readonly clock: () => number;

  constructor(path: string, clock: () => number = () => Date.now()) {
    // Resolved lazily so the module also loads where node:sqlite does not exist (older Node, a browser bundle).
    const loader = (
      globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }
    ).process?.getBuiltinModule;
    const mod = loader
      ? (loader("node:sqlite") as
          | { DatabaseSync?: typeof import("node:sqlite").DatabaseSync }
          | undefined)
      : undefined;
    const DatabaseSync = mod?.DatabaseSync;
    if (!DatabaseSync)
      throw new Error("SqliteStore requires Node.js 22.5 or newer.");
    this.database = new DatabaseSync(path);
    this.clock = clock;
    // PRAGMA rather than the constructor's `timeout` option: that option is only accepted from Node 22.16 and
    // 23.10 on, and this class must work from 22.5. The busy timeout is set first so every later statement waits.
    this.database.exec("PRAGMA busy_timeout = 30000");
    // WAL and NORMAL sync let several processes share the file. A path that cannot use WAL (":memory:" reports
    // "memory"; a read-only file throws) keeps its default journal, so a failure here is not fatal.
    tryPragma(this.database, "PRAGMA journal_mode = WAL");
    tryPragma(this.database, "PRAGMA synchronous = NORMAL");
    // Two processes can still race on the first schema write and one of them can be refused at once with
    // "database is locked" before the busy handler applies. Both statements are IF NOT EXISTS, so retrying is safe.
    for (let attempt = 1; ; attempt++) {
      try {
        this.database.exec(
          "CREATE TABLE IF NOT EXISTS proactive_gate_store (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, expires_at INTEGER)",
        );
        // The partial index keeps a sweep proportional to the dead rows instead of a table scan.
        this.database.exec(
          "CREATE INDEX IF NOT EXISTS proactive_gate_store_expires_at ON proactive_gate_store (expires_at) WHERE expires_at IS NOT NULL",
        );
        break;
      } catch (error) {
        if (attempt >= 5 || !/database is locked|SQLITE_BUSY/.test(String(error))) throw error;
        sleepSync(10 * attempt);
      }
    }
  }

  /**
   * A read prunes only the key it touches; a write first clears every row that
   * has already expired, so a key nobody reads again does not live forever.
   */
  private sweep(now: number): void {
    this.database
      .prepare(
        "DELETE FROM proactive_gate_store WHERE expires_at IS NOT NULL AND expires_at <= ?",
      )
      .run(now);
  }

  private live(
    key: string,
  ): { value: string; expiresAt: number | null } | undefined {
    const row = this.database
      .prepare(
        "SELECT value, expires_at FROM proactive_gate_store WHERE key = ?",
      )
      .get(key) as { value: string; expires_at: number | null } | undefined;
    if (!row) return undefined;
    if (row.expires_at !== null && row.expires_at <= this.clock()) {
      this.database
        .prepare("DELETE FROM proactive_gate_store WHERE key = ?")
        .run(key);
      return undefined;
    }
    return { value: row.value, expiresAt: row.expires_at };
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const now = this.clock();
    const expiresAt = ttlSeconds ? now + ttlSeconds * 1000 : null;
    this.sweep(now);
    this.database
      .prepare(
        "INSERT INTO proactive_gate_store (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
      )
      .run(key, value, expiresAt);
  }

  async incr(key: string, ttlSeconds?: number): Promise<number> {
    return this.incrBy(key, 1, ttlSeconds);
  }

  /**
   * INCRBY semantics; the TTL is attached only when the call creates the key, or finds it expired. The delta is cast to
   * INTEGER in SQL: node:sqlite binds a JavaScript number as REAL, and "100" + 1.0 would be stored as "101.0".
   */
  async incrBy(key: string, delta: number, ttlSeconds?: number): Promise<number> {
    const now = this.clock();
    const expiresAt = ttlSeconds ? now + ttlSeconds * 1000 : null;
    this.sweep(now);
    const row = this.database
      .prepare(
        "INSERT INTO proactive_gate_store (key, value, expires_at) VALUES (?, CAST(CAST(? AS INTEGER) AS TEXT), ?) ON CONFLICT(key) DO UPDATE SET value = CASE WHEN proactive_gate_store.expires_at IS NOT NULL AND proactive_gate_store.expires_at <= ? THEN CAST(CAST(? AS INTEGER) AS TEXT) ELSE CAST(CAST(proactive_gate_store.value AS INTEGER) + CAST(? AS INTEGER) AS TEXT) END, expires_at = CASE WHEN proactive_gate_store.expires_at IS NOT NULL AND proactive_gate_store.expires_at <= ? THEN excluded.expires_at ELSE proactive_gate_store.expires_at END RETURNING value",
      )
      .get(key, delta, expiresAt, now, delta, delta, now) as { value: string };
    return Number(row.value);
  }

  async del(key: string): Promise<void> {
    this.database
      .prepare("DELETE FROM proactive_gate_store WHERE key = ?")
      .run(key);
  }

  /** Test helper. */
  size(): number {
    const row = this.database
      .prepare("SELECT COUNT(*) AS n FROM proactive_gate_store")
      .get() as { n: number };
    return row.n;
  }

  close(): void {
    this.database.close();
  }
}
