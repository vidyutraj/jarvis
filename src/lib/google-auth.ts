import type { AuthProps } from "../auth/props";
import { refreshGoogleToken } from "./google-oauth";

/** Treat a token as expired this long before Google says, to cover slow requests. */
const EXPIRY_MARGIN_MS = 60_000;

export type GoogleAccessTokenResult =
	| { ok: true; accessToken: string }
	| { ok: false; reason: "needs_reconnect" | "unreachable" };

/**
 * A valid Google access token for tools that call Google APIs.
 *
 * Usually the token in the grant is fresh (refreshed alongside Claude's token).
 * If not, this refreshes it for the current call only: props are read-only inside
 * tools, and Google doesn't rotate refresh tokens, so nothing needs saving.
 */
export async function getGoogleAccessToken(
	auth: AuthProps,
	env: Pick<Env, "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET">,
	now = Date.now(),
): Promise<GoogleAccessTokenResult> {
	if (auth.googleExpiresAt - EXPIRY_MARGIN_MS > now) {
		return { ok: true, accessToken: auth.googleAccessToken };
	}

	const result = await refreshGoogleToken(env, auth.googleRefreshToken);
	if (result.ok) return { ok: true, accessToken: result.tokens.accessToken };
	return {
		ok: false,
		reason: result.reason === "invalid_grant" ? "needs_reconnect" : "unreachable",
	};
}

/** Spoken replies for tools when Google access fails. */
export const GOOGLE_ACCESS_FAILURE_REPLIES: Record<
	Extract<GoogleAccessTokenResult, { ok: false }>["reason"],
	string
> = {
	needs_reconnect:
		"I've lost access to your Google account. Reconnect Jarvis in Claude's settings and try again.",
	unreachable: "I couldn't reach Google just now. Try again in a moment.",
};
