import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { jsonResponse } from "./helpers";

/**
 * End-to-end through the real Worker (OAuthProvider + sign-in handler + MCP),
 * as Claude would connect: register → consent → Google → token → call a tool.
 * Only Google's endpoints are faked.
 */
const ORIGIN = "https://jarvis.test";
const MCP_URL = `${ORIGIN}/mcp`;
const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const CALENDAR_SCOPES =
	"https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events";

interface GoogleFake {
	email: string;
	emailVerified?: boolean;
	scope?: string;
	refreshError?: string;
}

function worker(path: string, init?: RequestInit): Promise<Response> {
	return exports.default.fetch(
		new Request(new URL(path, ORIGIN), { redirect: "manual", ...init }),
	);
}

/** Minimal cookie jar: the consent and upstream steps are bound to the browser by __Host- cookies. */
class CookieJar {
	private cookies = new Map<string, string>();
	store(response: Response): void {
		for (const cookie of response.headers.getSetCookie()) {
			const [pair] = cookie.split(";");
			const index = pair!.indexOf("=");
			this.cookies.set(pair!.slice(0, index), pair!.slice(index + 1));
		}
	}
	header(): string {
		return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
	}
}

async function s256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

function fakeGoogle(fake: GoogleFake): MockInstance<typeof fetch> {
	const realFetch = globalThis.fetch;
	return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = new Request(input).url;
		if (url === "https://oauth2.googleapis.com/token") {
			const form = new URLSearchParams(String(init?.body));
			if (form.get("grant_type") === "refresh_token") {
				return fake.refreshError
					? jsonResponse({ error: fake.refreshError }, 400)
					: jsonResponse({ access_token: "google-at-refreshed", expires_in: 3599 });
			}
			return jsonResponse({
				access_token: "google-at",
				refresh_token: "google-rt",
				expires_in: 3599,
				scope:
					fake.scope ??
					`openid https://www.googleapis.com/auth/userinfo.email ${CALENDAR_SCOPES}`,
			});
		}
		if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
			return jsonResponse({
				sub: "google-sub-123",
				email: fake.email,
				email_verified: fake.emailVerified ?? true,
			});
		}
		return realFetch(input, init);
	});
}

/** Runs the browser part of sign-in and returns the callback response from Jarvis. */
async function signIn(): Promise<{
	callback: Response;
	verifier: string;
	clientId: string;
	state: string;
}> {
	const registration = await worker("/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			client_name: "Claude",
			redirect_uris: [CLAUDE_REDIRECT],
			token_endpoint_auth_method: "none",
		}),
	});
	expect(registration.status).toBe(201);
	const { client_id: clientId } = (await registration.json()) as { client_id: string };

	const verifier = `${crypto.randomUUID()}${crypto.randomUUID()}`;
	const state = crypto.randomUUID();
	const jar = new CookieJar();

	const authorizeUrl = new URL("/authorize", ORIGIN);
	authorizeUrl.search = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: CLAUDE_REDIRECT,
		code_challenge: await s256(verifier),
		code_challenge_method: "S256",
		state,
		resource: MCP_URL,
	}).toString();
	const consent = await worker(authorizeUrl.toString());
	expect(consent.status).toBe(200);
	jar.store(consent);
	const html = await consent.text();
	expect(html).toContain("claude.ai"); // shows where access will be sent
	const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
	expect(handle).toBeTruthy();

	const approve = await worker("/authorize", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: jar.header() },
		body: new URLSearchParams({ handle: handle!, decision: "approve" }),
	});
	expect(approve.status).toBe(302);
	jar.store(approve);
	const googleUrl = new URL(approve.headers.get("Location")!);
	expect(googleUrl.host).toBe("accounts.google.com");
	expect(googleUrl.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/callback`);

	const callback = await worker(
		`/callback?code=google-code&state=${encodeURIComponent(googleUrl.searchParams.get("state")!)}`,
		{ headers: { Cookie: jar.header() } },
	);
	return { callback, verifier, clientId, state };
}

async function exchangeCode(code: string, verifier: string, clientId: string) {
	const response = await worker("/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: CLAUDE_REDIRECT,
			client_id: clientId,
			code_verifier: verifier,
			resource: MCP_URL,
		}),
	});
	expect(response.status).toBe(200);
	return (await response.json()) as { access_token: string; refresh_token: string };
}

function callPing(accessToken?: string): Promise<Response> {
	return worker("/mcp", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"mcp-protocol-version": "2025-06-18",
			...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "ping", arguments: {} },
		}),
	});
}

describe("OAuth-protected MCP server", () => {
	beforeEach(() => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("rejects tool calls without a token and points Claude to sign-in", async () => {
		const response = await callPing();

		expect(response.status).toBe(401);
		expect(response.headers.get("WWW-Authenticate")).toContain(
			`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
		);
	});

	it("rejects a made-up token", async () => {
		expect((await callPing("not-a-real-token")).status).toBe(401);
	});

	it("lets the allowed account sign in and use tools", async () => {
		fakeGoogle({ email: "owner@example.com" });

		const { callback, verifier, clientId, state } = await signIn();
		expect(callback.status).toBe(302);
		const redirect = new URL(callback.headers.get("Location")!);
		expect(`${redirect.origin}${redirect.pathname}`).toBe(CLAUDE_REDIRECT);
		expect(redirect.searchParams.get("state")).toBe(state);

		const tokens = await exchangeCode(redirect.searchParams.get("code")!, verifier, clientId);
		const response = await callPing(tokens.access_token);

		expect(response.status).toBe(200);
		expect(await response.text()).toContain("Pong! Your server is live.");
	});

	it("refuses any other Google account before issuing a grant", async () => {
		fakeGoogle({ email: "stranger@example.com" });

		const { callback } = await signIn();

		expect(callback.status).toBe(403);
		expect(callback.headers.get("Location")).toBeNull();
		expect(await callback.text()).toContain("isn&#39;t allowed");
	});

	it("refuses an unverified Google email even if it matches", async () => {
		fakeGoogle({ email: "owner@example.com", emailVerified: false });
		expect((await signIn()).callback.status).toBe(403);
	});

	it("asks to reconnect if calendar permission wasn't granted", async () => {
		fakeGoogle({ email: "owner@example.com", scope: "openid email" });

		const { callback } = await signIn();

		expect(callback.status).toBe(403);
		expect(await callback.text()).toContain("calendar");
	});

	it("refreshes tokens, and signs Claude out when Google access is revoked", async () => {
		const google = { email: "owner@example.com" } as GoogleFake;
		fakeGoogle(google);
		const { callback, verifier, clientId } = await signIn();
		const code = new URL(callback.headers.get("Location")!).searchParams.get("code")!;
		const tokens = await exchangeCode(code, verifier, clientId);

		const refresh = (refreshToken: string) =>
			worker("/token", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "refresh_token",
					refresh_token: refreshToken,
					client_id: clientId,
				}),
			});

		const refreshed = await refresh(tokens.refresh_token);
		expect(refreshed.status).toBe(200);
		const next = (await refreshed.json()) as { access_token: string; refresh_token: string };
		expect((await callPing(next.access_token)).status).toBe(200);

		google.refreshError = "invalid_grant";
		const revoked = await refresh(next.refresh_token);
		expect(revoked.status).toBe(400);
		expect(((await revoked.json()) as { error: string }).error).toBe("invalid_grant");
	});

	it("serves the public home page and privacy policy without sign-in", async () => {
		const home = await worker("/");
		expect(home.status).toBe(200);
		expect(await home.text()).toContain("single-user voice assistant");

		const privacy = await worker("/privacy");
		expect(privacy.status).toBe(200);
		const text = await privacy.text();
		expect(text).toContain("Limited Use");
		expect(text).toContain("myaccount.google.com/permissions");
	});

	it("rejects a callback that didn't start in this browser", async () => {
		const response = await worker("/callback?code=stolen-code&state=forged-state");
		expect(response.status).toBe(400);
	});
});
