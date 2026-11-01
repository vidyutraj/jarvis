import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * End-to-end tests against the real Plaid Sandbox (`npm run test:sandbox`).
 * Unlike vitest.config.ts, Plaid keys, JARVIS_SECRET_KEY and Telegram come from
 * .dev.vars. The tests refuse to run unless PLAID_ENV is "sandbox", and never
 * print keys or tokens.
 */
export default defineConfig({
	plugins: [
		cloudflareTest(async () => ({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: {
					TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")),
				},
			},
		})),
	],
	test: {
		include: ["test/sandbox/**/*.{sandbox,interactive}.ts"],
		setupFiles: ["./test/apply-migrations.ts"],
		testTimeout: 360_000,
		hookTimeout: 120_000,
	},
});
