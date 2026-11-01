import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Only applies migrations that haven't run yet, so re-running per file is safe.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
