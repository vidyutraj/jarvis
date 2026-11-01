// Secrets aren't declared in wrangler.jsonc, so `wrangler types` can't see them
// unless a .dev.vars file happens to exist. Declaring them here keeps the Env
// type stable either way (these interfaces merge with worker-configuration.d.ts).
// Set locally in .dev.vars and in production with `wrangler secret put`.
interface JarvisSecrets {
	TELEGRAM_BOT_TOKEN: string;
	TELEGRAM_CHAT_ID: string;
	/** Google Cloud OAuth client (type: Web application). */
	GOOGLE_CLIENT_ID: string;
	GOOGLE_CLIENT_SECRET: string;
	/** The only Google account allowed to sign in. */
	ALLOWED_EMAIL: string;
	/** Plaid API keys (Dashboard → Developers → Keys). The secret is per environment. */
	PLAID_CLIENT_ID: string;
	PLAID_SECRET: string;
	/**
	 * At least 32 random bytes, base64. Encrypts stored Plaid tokens and signs
	 * spending-page links. Changing it makes stored bank connections unusable.
	 */
	JARVIS_SECRET_KEY: string;
}

interface JarvisBindings extends JarvisSecrets {
	/** Injected at runtime by OAuthProvider for the sign-in handler. */
	OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
}

// The global Env (fetch handler argument) and Cloudflare.Env (`import { env } from
// "cloudflare:workers"`) are separate interfaces, so both get the extra bindings.
interface Env extends JarvisBindings {}
declare namespace Cloudflare {
	interface Env extends JarvisBindings {}
}
