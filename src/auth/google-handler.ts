import {
	AuthorizationError,
	CimdFetchError,
	authorizationErrorRedirect,
} from "@cloudflare/workers-oauth-provider";
import {
	GOOGLE_CALENDAR_SCOPES,
	exchangeGoogleCode,
	fetchGoogleUser,
	googleAuthorizeUrl,
} from "../lib/google-oauth";
import { isAllowedEmail } from "./allowlist";
import { consentPage, messagePage } from "./pages";
import type { AuthProps } from "./props";

interface UpstreamData {
	verifier: string;
}

/**
 * Sign-in flow (the OAuthProvider's defaultHandler):
 *   GET  /authorize  → consent page (which app is asking, where access goes)
 *   POST /authorize  → user approved → redirect to Google with state + PKCE
 *   GET  /callback   → Google returns → check the account is allowed → issue the grant
 * The library's consent/upstream helpers bind each step to the browser with
 * single-use __Host- cookies, so the flow can't be forged, framed or replayed.
 */
export const googleAuthHandler = {
	async fetch(request: Request, env: Env): Promise<Response> {
		const { pathname } = new URL(request.url);
		try {
			if (pathname === "/authorize" && request.method === "GET")
				return await showConsent(request, env);
			if (pathname === "/authorize" && request.method === "POST")
				return await handleConsentDecision(request, env);
			if (pathname === "/callback" && request.method === "GET")
				return await handleGoogleCallback(request, env);
			return new Response("Not found", { status: 404 });
		} catch (error) {
			return handleAuthorizationError(error);
		}
	},
} satisfies ExportedHandler<Env>;

async function showConsent(request: Request, env: Env): Promise<Response> {
	const oauth = env.OAUTH_PROVIDER;
	const authRequest = await oauth.parseAuthRequest(request);
	const details = await oauth.describeConsent(authRequest);
	const consent = await oauth.beginConsent(authRequest);
	consent.headers.set("Content-Type", "text/html; charset=utf-8");
	return new Response(consentPage(details, consent.handle), { headers: consent.headers });
}

async function handleConsentDecision(request: Request, env: Env): Promise<Response> {
	const oauth = env.OAUTH_PROVIDER;
	const form = await request.formData();
	const handle = String(form.get("handle") ?? "");

	if (form.get("decision") !== "approve") {
		const denied = await oauth.denyConsent(request, handle);
		return new Response(null, { status: 302, headers: denied.headers });
	}

	const approved = await oauth.approveConsent(request, handle);
	// PKCE between Jarvis and Google; the verifier stays server-side (encrypted) until the callback.
	const verifier = `${crypto.randomUUID()}${crypto.randomUUID()}`;
	const { state, headers } = await oauth.beginUpstream(approved.request, {
		data: { verifier } satisfies UpstreamData,
		headers: approved.headers,
	});
	headers.set(
		"Location",
		googleAuthorizeUrl({
			clientId: env.GOOGLE_CLIENT_ID,
			redirectUri: googleRedirectUri(env),
			state,
			codeChallenge: await s256(verifier),
			loginHint: env.ALLOWED_EMAIL,
		}),
	);
	return new Response(null, { status: 302, headers });
}

async function handleGoogleCallback(request: Request, env: Env): Promise<Response> {
	const oauth = env.OAUTH_PROVIDER;
	const params = new URL(request.url).searchParams;
	const { request: original, data, headers } = await oauth.finishUpstream<UpstreamData>(request);

	const code = params.get("code");
	if (params.get("error") || !code) {
		headers.set("Location", authorizationErrorRedirect(original, "access_denied"));
		return new Response(null, { status: 302, headers });
	}

	const exchanged = await exchangeGoogleCode(env, code, data.verifier, googleRedirectUri(env));
	if (!exchanged.ok) {
		return htmlResponse(
			502,
			"Sign-in didn't finish",
			"Google didn't complete the sign-in. Try connecting again.",
		);
	}
	const { tokens } = exchanged;

	const userResult = await fetchGoogleUser(tokens.accessToken);
	if (!userResult.ok) {
		return htmlResponse(
			502,
			"Sign-in didn't finish",
			"Couldn't confirm your Google account. Try connecting again.",
		);
	}
	const { user } = userResult;

	// The allowlist check happens before any grant exists: other accounts never get a token.
	if (!user.emailVerified || !isAllowedEmail(user.email, env.ALLOWED_EMAIL)) {
		console.warn("Rejected sign-in from a Google account that isn't on the allowlist.");
		return htmlResponse(403, "Not allowed", "This Google account isn't allowed to use Jarvis.");
	}

	const missingScopes = GOOGLE_CALENDAR_SCOPES.filter((scope) => !tokens.scopes.includes(scope));
	if (missingScopes.length > 0) {
		return htmlResponse(
			403,
			"Calendar access needed",
			"Jarvis needs permission to see your calendars and manage events. Connect again and tick both calendar boxes on Google's screen.",
		);
	}

	if (!tokens.refreshToken) {
		console.error(
			"Google returned no refresh token despite access_type=offline and prompt=consent.",
		);
		return htmlResponse(
			502,
			"Sign-in didn't finish",
			"Google didn't grant ongoing access. Try connecting again.",
		);
	}

	const props: AuthProps = {
		sub: user.sub,
		email: user.email,
		googleAccessToken: tokens.accessToken,
		googleRefreshToken: tokens.refreshToken,
		googleExpiresAt: tokens.expiresAt,
	};
	const { redirectTo } = await oauth.completeAuthorization({
		request: original,
		userId: user.sub,
		metadata: { email: user.email },
		scope: original.scope,
		props,
	});
	headers.set("Location", redirectTo);
	return new Response(null, { status: 302, headers });
}

function handleAuthorizationError(error: unknown): Response {
	// Only redirect back to the client once the library has validated its redirect URI.
	if (error instanceof AuthorizationError && error.redirectTo) {
		return Response.redirect(error.redirectTo, 302);
	}
	if (error instanceof AuthorizationError) {
		return htmlResponse(
			400,
			"Sign-in didn't work",
			`${error.description} Start connecting again from Claude.`,
		);
	}
	if (error instanceof CimdFetchError) {
		return htmlResponse(400, "Sign-in didn't work", "This app couldn't be verified.");
	}
	throw error; // A bug or an outage: surface it as a 500.
}

function googleRedirectUri(env: Env): string {
	return new URL("/callback", env.MCP_RESOURCE).toString();
}

async function s256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

function htmlResponse(status: number, title: string, message: string): Response {
	return new Response(messagePage(title, message), {
		status,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
			"Content-Security-Policy": "frame-ancestors 'none'",
			"X-Frame-Options": "DENY",
		},
	});
}
