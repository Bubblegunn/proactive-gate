# Roadmap

Next steps, in no particular order. Open an issue if you want to take one.

- A `PostgresStore` alongside `MemoryStore`, `SqliteStore` and `RedisStore`, in both languages
- A `digest` helper that batches deferred and rejected candidates into one later delivery
- More presets with sources: WhatsApp Business messaging limits, Apple push quiet-time guidance, Brazil's LGPD marketing consent
- A Go or Rust implementation held to `spec/fixtures`

Things deliberately not planned: anything that needs a server, a hosted account, or reads message content.
