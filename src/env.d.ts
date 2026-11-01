// Secrets aren't declared in wrangler.jsonc, so `wrangler types` can't see them
// unless a .dev.vars file happens to exist. Declaring them here keeps the Env
// type stable either way (these interfaces merge with worker-configuration.d.ts).
// Set locally in .dev.vars and in production with `wrangler secret put`.
interface JarvisSecrets {
	TELEGRAM_BOT_TOKEN: string;
	TELEGRAM_CHAT_ID: string;
}

// The global Env (fetch handler argument) and Cloudflare.Env (`import { env } from
// "cloudflare:workers"`) are separate interfaces, so both get the secrets.
interface Env extends JarvisSecrets {}
declare namespace Cloudflare {
	interface Env extends JarvisSecrets {}
}
