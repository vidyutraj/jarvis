const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const REQUEST_TIMEOUT_MS = 10_000;

export const GOOGLE_CALENDAR_SCOPES = [
	// List calendars (to map names like "Work" to IDs). Read-only.
	"https://www.googleapis.com/auth/calendar.calendarlist.readonly",
	// Create and edit events. No access to calendar settings or sharing.
	"https://www.googleapis.com/auth/calendar.events",
] as const;

export const GOOGLE_SCOPES = ["openid", "email", ...GOOGLE_CALENDAR_SCOPES] as const;

type GoogleEnv = Pick<Env, "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET">;

export interface GoogleTokens {
	accessToken: string;
	/** Google only returns this on the first exchange (and rarely on refresh). */
	refreshToken?: string;
	/** Epoch milliseconds. */
	expiresAt: number;
	scopes: string[];
}

export type GoogleTokenResult =
	| { ok: true; tokens: GoogleTokens }
	/** invalid_grant: the refresh token or code is dead for good (revoked, expired, reused). */
	| { ok: false; reason: "invalid_grant" | "rejected" | "unreachable" };

export interface GoogleUser {
	sub: string;
	email: string;
	emailVerified: boolean;
}

export type GoogleUserResult = { ok: true; user: GoogleUser } | { ok: false };

export interface GoogleAuthorizeParams {
	clientId: string;
	redirectUri: string;
	state: string;
	codeChallenge: string;
	loginHint?: string;
}

/** Google consent URL with offline access (refresh token) and S256 PKCE. */
export function googleAuthorizeUrl(params: GoogleAuthorizeParams): string {
	const url = new URL(GOOGLE_AUTHORIZE_URL);
	url.search = new URLSearchParams({
		client_id: params.clientId,
		redirect_uri: params.redirectUri,
		response_type: "code",
		scope: GOOGLE_SCOPES.join(" "),
		state: params.state,
		code_challenge: params.codeChallenge,
		code_challenge_method: "S256",
		access_type: "offline",
		// Forces a refresh token on every sign-in, even if Google remembers consent.
		prompt: "consent",
		include_granted_scopes: "true",
		...(params.loginHint ? { login_hint: params.loginHint } : {}),
	}).toString();
	return url.toString();
}

export function exchangeGoogleCode(
	env: GoogleEnv,
	code: string,
	codeVerifier: string,
	redirectUri: string,
): Promise<GoogleTokenResult> {
	return requestGoogleTokens({
		grant_type: "authorization_code",
		code,
		code_verifier: codeVerifier,
		redirect_uri: redirectUri,
		client_id: env.GOOGLE_CLIENT_ID,
		client_secret: env.GOOGLE_CLIENT_SECRET,
	});
}

export function refreshGoogleToken(
	env: GoogleEnv,
	refreshToken: string,
): Promise<GoogleTokenResult> {
	return requestGoogleTokens({
		grant_type: "refresh_token",
		refresh_token: refreshToken,
		client_id: env.GOOGLE_CLIENT_ID,
		client_secret: env.GOOGLE_CLIENT_SECRET,
	});
}

export async function fetchGoogleUser(accessToken: string): Promise<GoogleUserResult> {
	try {
		const response = await fetch(GOOGLE_USERINFO_URL, {
			headers: { Authorization: `Bearer ${accessToken}` },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!response.ok) {
			console.error(`Google userinfo failed (HTTP ${response.status}).`);
			return { ok: false };
		}
		const body = (await response.json()) as Record<string, unknown>;
		if (typeof body.sub !== "string" || typeof body.email !== "string") return { ok: false };
		return {
			ok: true,
			user: { sub: body.sub, email: body.email, emailVerified: body.email_verified === true },
		};
	} catch (error) {
		console.error(`Google userinfo request failed (${errorName(error)}).`);
		return { ok: false };
	}
}

/** Tokens, codes and the client secret are in the body, so neither it nor the response is ever logged. */
async function requestGoogleTokens(form: Record<string, string>): Promise<GoogleTokenResult> {
	let response: Response;
	try {
		response = await fetch(GOOGLE_TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(form),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch (error) {
		console.error(`Google token request failed (${errorName(error)}).`);
		return { ok: false, reason: "unreachable" };
	}

	const body = await readJson(response);
	if (!response.ok) {
		const error = typeof body?.error === "string" ? body.error : "unknown_error";
		console.error(
			`Google token endpoint rejected ${form.grant_type} (HTTP ${response.status}): ${error}`,
		);
		return { ok: false, reason: error === "invalid_grant" ? "invalid_grant" : "rejected" };
	}

	if (typeof body?.access_token !== "string" || typeof body.expires_in !== "number") {
		console.error("Google token response was missing access_token or expires_in.");
		return { ok: false, reason: "rejected" };
	}

	return {
		ok: true,
		tokens: {
			accessToken: body.access_token,
			refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
			expiresAt: Date.now() + body.expires_in * 1000,
			scopes: typeof body.scope === "string" ? body.scope.split(" ") : [],
		},
	};
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
	try {
		return (await response.json()) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function errorName(error: unknown): string {
	return error instanceof Error ? error.name : "UnknownError";
}
