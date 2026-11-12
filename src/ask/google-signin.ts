import { isAllowedEmail } from "../auth/allowlist";
import type { AuthProps } from "../auth/props";
import { refreshGoogleToken } from "../lib/google-oauth";
import { decryptSecret, encryptSecret } from "../lib/secret-box";

/**
 * "Hey Jarvis" (/ask) runs outside Claude's connector, so it has no OAuth grant
 * to read the Google tokens from. Each Google sign-in (and each token refresh
 * Claude triggers) saves the owner's Google refresh token here, encrypted with
 * a key derived from JARVIS_SECRET_KEY, so /ask can act as the owner. The
 * current access token is saved too, so most questions skip a Google refresh.
 */
const KV_KEY = "jarvis:ask:google-signin";
/** Reuse a saved access token only if it has at least this long left. */
const REUSE_MARGIN_MS = 5 * 60_000;

interface SavedSignIn {
	sub: string;
	email: string;
	refreshToken: string;
	accessToken?: string;
	/** Epoch milliseconds. */
	expiresAt?: number;
}

type SignInEnv = Pick<
	Env,
	"OAUTH_KV" | "JARVIS_SECRET_KEY" | "ALLOWED_EMAIL" | "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET"
>;

/** Saves the signed-in owner's Google refresh token. Never throws: sign-in must not fail because of this. */
export async function rememberGoogleSignIn(env: SignInEnv, props: AuthProps): Promise<void> {
	if (!isAllowedEmail(props.email, env.ALLOWED_EMAIL)) return;
	try {
		const saved: SavedSignIn = {
			sub: props.sub,
			email: props.email,
			refreshToken: props.googleRefreshToken,
			accessToken: props.googleAccessToken,
			expiresAt: props.googleExpiresAt,
		};
		const sealed = await encryptSecret(
			env.JARVIS_SECRET_KEY,
			"google-refresh-token",
			JSON.stringify(saved),
		);
		await env.OAUTH_KV.put(KV_KEY, sealed);
	} catch (error) {
		const name = error instanceof Error ? error.name : "UnknownError";
		console.error(`Couldn't save the Google sign-in for Hey Jarvis (${name}).`);
	}
}

/** `refreshed` means the caller should save `auth` (ideally after replying). */
export type AskAuthResult = { ok: true; auth: AuthProps; refreshed: boolean } | { ok: false };

/**
 * The owner's identity and a usable Google access token for one /ask request:
 * the saved token while it has 5+ minutes left, otherwise one refresh. If Google
 * refuses the refresh, the token is left expired so Google tools speak their
 * usual "reconnect" reply while bank and note tools still work.
 */
export async function loadAskAuth(env: SignInEnv, now = Date.now()): Promise<AskAuthResult> {
	let saved: SavedSignIn;
	try {
		const sealed = await env.OAUTH_KV.get(KV_KEY);
		if (!sealed) return { ok: false };
		const plain = await decryptSecret(env.JARVIS_SECRET_KEY, "google-refresh-token", sealed);
		if (!plain) return { ok: false };
		saved = JSON.parse(plain) as SavedSignIn;
	} catch {
		return { ok: false };
	}
	if (!isAllowedEmail(saved.email, env.ALLOWED_EMAIL)) return { ok: false };

	const auth: AuthProps = {
		sub: saved.sub,
		email: saved.email,
		googleAccessToken: saved.accessToken ?? "",
		googleRefreshToken: saved.refreshToken,
		googleExpiresAt: saved.expiresAt ?? 0,
	};
	if (auth.googleAccessToken && auth.googleExpiresAt - REUSE_MARGIN_MS > now) {
		return { ok: true, auth, refreshed: false };
	}

	const result = await refreshGoogleToken(env, saved.refreshToken);
	if (!result.ok) return { ok: true, auth, refreshed: false };
	auth.googleAccessToken = result.tokens.accessToken;
	auth.googleExpiresAt = result.tokens.expiresAt;
	if (result.tokens.refreshToken) auth.googleRefreshToken = result.tokens.refreshToken;
	return { ok: true, auth, refreshed: true };
}
