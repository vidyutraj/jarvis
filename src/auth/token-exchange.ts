import {
	GrantType,
	OAuthError,
	type TokenExchangeCallbackOptions,
	type TokenExchangeCallbackResult,
} from "@cloudflare/workers-oauth-provider";
import { refreshGoogleToken } from "../lib/google-oauth";
import { isAuthProps, type AuthProps } from "./props";

/** Jarvis's own access token expires this long before Google's, so Claude refreshes first. */
const EXPIRY_MARGIN_SECONDS = 300;
const MIN_ACCESS_TOKEN_TTL_SECONDS = 60;

/**
 * Keeps the Google token inside the grant fresh. Claude refreshes its Jarvis
 * token shortly before it expires; each refresh refreshes Google's token too.
 */
export async function handleTokenExchange(
	options: TokenExchangeCallbackOptions<Env>,
): Promise<TokenExchangeCallbackResult | void> {
	const { grantType, props, env } = options;
	if (!isAuthProps(props)) return;

	if (grantType === GrantType.AUTHORIZATION_CODE) {
		return { accessTokenTTL: accessTokenTtl(props.googleExpiresAt) };
	}
	if (grantType !== GrantType.REFRESH_TOKEN) return;

	const result = await refreshGoogleToken(env, props.googleRefreshToken);
	if (!result.ok) {
		if (result.reason === "invalid_grant") {
			// Access was revoked or expired for good: the library revokes this grant so Claude signs in again.
			throw new OAuthError("invalid_grant", { description: "Google access was revoked." });
		}
		throw new OAuthError("temporarily_unavailable", {
			description: "Google is unavailable. Try again shortly.",
			statusCode: 503,
		});
	}

	const newProps: AuthProps = {
		...props,
		googleAccessToken: result.tokens.accessToken,
		// Google rarely rotates refresh tokens; keep the old one unless it sends a new one.
		googleRefreshToken: result.tokens.refreshToken ?? props.googleRefreshToken,
		googleExpiresAt: result.tokens.expiresAt,
	};
	return { newProps, accessTokenTTL: accessTokenTtl(newProps.googleExpiresAt) };
}

export function accessTokenTtl(googleExpiresAt: number, now = Date.now()): number {
	const secondsLeft = Math.floor((googleExpiresAt - now) / 1000) - EXPIRY_MARGIN_SECONDS;
	return Math.max(MIN_ACCESS_TOKEN_TTL_SECONDS, secondsLeft);
}
