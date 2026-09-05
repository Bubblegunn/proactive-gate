import type { DatabaseSync } from "node:sqlite";
import type { Store } from "./types.js";

/** In-process store. Correct for one instance, wrong the moment you scale out. */
export class MemoryStore implements Store {
  private readonly data = new Map<string, { value: string; expiresAt: number | null }>();

  constructor(private readonly clock: () => number = () => Date.now()) {}

  private live(key: string): { value: string; expiresAt: number | null } | undefined {
    const entry = this.data.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= this.clock()) {
      this.data.delete(key);
      return undefined;
    }
    return entry;
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    this.data.set(key, { value, expiresAt: ttlSeconds ? this.clock() + ttlSeconds * 1000 : null });
  }

  async incr(key: string, ttlSeconds?: number): Promise<number> {
    const current = this.live(key);
    const next = (current ? Number(current.value) : 0) + 1;
    const expiresAt = current ? current.expiresAt : ttlSeconds ? this.clock() + ttlSeconds * 1000 : null;
    this.data.set(key, { value: String(next), expiresAt });
    return next;
  }

  async del(key: string): Promise<void> {
    this.data.delete(key);
  }

  /** Test helper. */
  size(): number {
    return this.data.size;
  }
}

/**
 * The subset of a Redis client the gate needs. Both ioredis and node-redis
 * satisfy it (node-redis names are upper-case; pass a small adapter).
 */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: any[]): Promise<unknown>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

/**
 * Redis-backed store. `incr` is atomic on the server, which is what makes the
 * daily budget safe across many instances; the TTL is attached on the first
 * increment so a day's counter disappears on its own.
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
    const next = await this.client.incr(key);
    if (next === 1 && ttlSeconds) await this.client.expire(key, ttlSeconds);
    return next;
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }
}

export class SqliteStore implements Store {
  private readonly database: DatabaseSync;
  private readonly clock: () => number;

  constructor(path: string, clock: () => number = () => Date.now()) {
    // Resolved lazily so the module also loads where node:sqlite does not exist (older Node, a browser bundle).
    const loader = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process?.getBuiltinModule;
    const mod = loader ? (loader("node:sqlite") as { DatabaseSync?: typeof import("node:sqlite").DatabaseSync } | undefined) : undefined;
    const DatabaseSync = mod?.DatabaseSync;
    if (!DatabaseSync) throw new Error("SqliteStore requires Node.js 22.5 or newer.");
    this.database = new DatabaseSync(path);
    this.clock = clock;
    this.database.exec(
      "CREATE TABLE IF NOT EXISTS proactive_gate_store (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, expires_at INTEGER)",
    );
  }

  private live(key: string): { value: string; expiresAt: number | null } | undefined {
    const row = this.database.prepare("SELECT value, expires_at FROM proactive_gate_store WHERE key = ?").get(key) as
      | { value: string; expires_at: number | null }
      | undefined;
    if (!row) return undefined;
    if (row.expires_at !== null && row.expires_at <= this.clock()) {
      this.database.prepare("DELETE FROM proactive_gate_store WHERE key = ?").run(key);
      return undefined;
    }
    return { value: row.value, expiresAt: row.expires_at };
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const expiresAt = ttlSeconds ? this.clock() + ttlSeconds * 1000 : null;
    this.database
      .prepare(
        "INSERT INTO proactive_gate_store (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
      )
      .run(key, value, expiresAt);
  }

  async incr(key: string, ttlSeconds?: number): Promise<number> {
    const now = this.clock();
    const expiresAt = ttlSeconds ? now + ttlSeconds * 1000 : null;
    const row = this.database
      .prepare(
        "INSERT INTO proactive_gate_store (key, value, expires_at) VALUES (?, '1', ?) ON CONFLICT(key) DO UPDATE SET value = CASE WHEN proactive_gate_store.expires_at IS NOT NULL AND proactive_gate_store.expires_at <= ? THEN '1' ELSE CAST(CAST(proactive_gate_store.value AS INTEGER) + 1 AS TEXT) END, expires_at = CASE WHEN proactive_gate_store.expires_at IS NOT NULL AND proactive_gate_store.expires_at <= ? THEN excluded.expires_at ELSE proactive_gate_store.expires_at END RETURNING value",
      )
      .get(key, expiresAt, now, now) as { value: string };
    return Number(row.value);
  }

  async del(key: string): Promise<void> {
    this.database.prepare("DELETE FROM proactive_gate_store WHERE key = ?").run(key);
  }

  close(): void {
    this.database.close();
  }
}
