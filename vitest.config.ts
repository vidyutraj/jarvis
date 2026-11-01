import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
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
				},
			},
		}),
	],
});
