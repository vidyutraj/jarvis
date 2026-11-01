import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest(async () => ({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				// Fake values so tests never depend on (or leak) real secrets in .dev.vars.
				bindings: {
					TELEGRAM_BOT_TOKEN: "test-bot-token",
					TELEGRAM_CHAT_ID: "123456",
					GOOGLE_CLIENT_ID: "test-google-client-id",
					GOOGLE_CLIENT_SECRET: "test-google-client-secret",
					ALLOWED_EMAIL: "owner@example.com",
					MCP_RESOURCE: "https://jarvis.test/mcp",
					PLAID_CLIENT_ID: "test-plaid-client-id",
					PLAID_SECRET: "test-plaid-secret",
					PLAID_ENV: "sandbox",
					// 32 bytes of 0x2a, base64. Test-only.
					JARVIS_SECRET_KEY: "KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio=",
					TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")),
				},
			},
		})),
	],
	test: { setupFiles: ["./test/apply-migrations.ts"] },
});
