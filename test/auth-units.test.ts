import {
	OAuthError,
	GrantType,
	type TokenExchangeCallbackOptions,
} from "@cloudflare/workers-oauth-provider";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { isAllowedEmail } from "../src/auth/allowlist";
import { escapeHtml } from "../src/auth/pages";
import { isAuthProps } from "../src/auth/props";
import { accessTokenTtl, handleTokenExchange } from "../src/auth/token-exchange";
import { GOOGLE_ACCESS_FAILURE_REPLIES, getGoogleAccessToken } from "../src/lib/google-auth";
import {
	exchangeGoogleCode,
	googleAuthorizeUrl,
	refreshGoogleToken,
} from "../src/lib/google-oauth";
import { expectSpeakableText, jsonResponse, testAuth, testEnv } from "./helpers";

describe("isAllowedEmail", () => {
	it("matches the allowed email case-insensitively and ignoring spaces", () => {
		expect(isAllowedEmail("Owner@Example.com ", "owner@example.com")).toBe(true);
	});

	it("rejects any other email", () => {
		expect(isAllowedEmail("someone@example.com", "owner@example.com")).toBe(false);
	});

	it("fails closed when no allowed email is configured", () => {
		expect(isAllowedEmail("owner@example.com", "")).toBe(false);
		expect(isAllowedEmail("", "")).toBe(false);
		expect(isAllowedEmail(undefined, undefined)).toBe(false);
	});
});

describe("escapeHtml", () => {
	it("neutralises markup from self-registered client names", () => {
		expect(escapeHtml(`<script>alert("x")</script>`)).not.toContain("<");
	});
});

describe("isAuthProps", () => {
	it("accepts complete props and rejects anything else", () => {
		expect(isAuthProps(testAuth())).toBe(true);
		expect(isAuthProps({ email: "owner@example.com" })).toBe(false);
		expect(isAuthProps(undefined)).toBe(false);
	});
});

describe("googleAuthorizeUrl", () => {
	it("asks for offline access, calendar scopes and S256 PKCE", () => {
		const url = new URL(
			googleAuthorizeUrl({
				clientId: "cid",
				redirectUri: "https://jarvis.test/callback",
				state: "st",
				codeChallenge: "challenge",
				loginHint: "owner@example.com",
			}),
		);
		const params = url.searchParams;
		expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
		expect(params.get("access_type")).toBe("offline");
		expect(params.get("prompt")).toBe("consent");
		expect(params.get("code_challenge_method")).toBe("S256");
		expect(params.get("state")).toBe("st");
		expect(params.get("scope")?.split(" ")).toEqual([
			"openid",
			"email",
			"https://www.googleapis.com/auth/calendar.calendarlist.readonly",
			"https://www.googleapis.com/auth/calendar.events",
		]);
	});
});

describe("Google token requests", () => {
	let fetchSpy: MockInstance<typeof fetch>;
	let errorSpy: MockInstance<typeof console.error>;

	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, "fetch");
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("parses a successful code exchange", async () => {
		fetchSpy.mockResolvedValue(
			jsonResponse({
				access_token: "at",
				refresh_token: "rt",
				expires_in: 3599,
				scope: "openid email",
			}),
		);

		const result = await exchangeGoogleCode(
			testEnv(),
			"code",
			"verifier",
			"https://jarvis.test/callback",
		);

		expect(result).toMatchObject({
			ok: true,
			tokens: { accessToken: "at", refreshToken: "rt", scopes: ["openid", "email"] },
		});
		const body = new URLSearchParams(String(fetchSpy.mock.calls[0]![1]?.body));
		expect(body.get("code_verifier")).toBe("verifier");
		expect(body.get("client_secret")).toBe("test-google-client-secret");
	});

	it("maps invalid_grant so revoked access can be detected", async () => {
		fetchSpy.mockResolvedValue(jsonResponse({ error: "invalid_grant" }, 400));
		expect(await refreshGoogleToken(testEnv(), "rt")).toEqual({
			ok: false,
			reason: "invalid_grant",
		});
	});

	it("maps network failures to unreachable", async () => {
		fetchSpy.mockRejectedValue(new TypeError("network down"));
		expect(await refreshGoogleToken(testEnv(), "rt")).toEqual({
			ok: false,
			reason: "unreachable",
		});
	});

	it("never logs tokens or the client secret", async () => {
		fetchSpy.mockResolvedValue(jsonResponse({ error: "invalid_client" }, 401));
		await refreshGoogleToken(testEnv(), "secret-refresh-token");
		const logged = errorSpy.mock.calls.flat().join(" ");
		expect(logged).not.toContain("secret-refresh-token");
		expect(logged).not.toContain("test-google-client-secret");
	});
});

describe("handleTokenExchange", () => {
	let fetchSpy: MockInstance<typeof fetch>;

	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, "fetch");
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function options(
		grantType: GrantType,
		props: unknown = testAuth(),
	): TokenExchangeCallbackOptions<Env> {
		return {
			grantType,
			props,
			env: testEnv(),
			clientId: "client",
			subjectClientId: "client",
			userId: "google-sub-123",
			grantId: "grant",
			scope: [],
			requestedScope: [],
			resource: "https://jarvis.test/mcp",
		};
	}

	it("matches Jarvis's token lifetime to Google's on the first exchange", async () => {
		const result = await handleTokenExchange(options(GrantType.AUTHORIZATION_CODE));
		expect(result?.accessTokenTTL).toBeGreaterThan(3000);
		expect(result?.accessTokenTTL).toBeLessThanOrEqual(3300);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("refreshes Google's token and keeps the existing refresh token", async () => {
		fetchSpy.mockResolvedValue(jsonResponse({ access_token: "new-at", expires_in: 3599 }));

		const result = await handleTokenExchange(options(GrantType.REFRESH_TOKEN));

		expect(result?.newProps).toMatchObject({
			googleAccessToken: "new-at",
			googleRefreshToken: "google-refresh-token",
			email: "owner@example.com",
		});
	});

	it("throws invalid_grant when Google access was revoked, so Claude signs in again", async () => {
		fetchSpy.mockResolvedValue(jsonResponse({ error: "invalid_grant" }, 400));

		const error = await handleTokenExchange(options(GrantType.REFRESH_TOKEN)).catch(
			(e: unknown) => e,
		);

		expect(error).toBeInstanceOf(OAuthError);
		expect((error as OAuthError).code).toBe("invalid_grant");
	});

	it("throws temporarily_unavailable when Google can't be reached, keeping the grant", async () => {
		fetchSpy.mockRejectedValue(new TypeError("network down"));

		const error = await handleTokenExchange(options(GrantType.REFRESH_TOKEN)).catch(
			(e: unknown) => e,
		);

		expect((error as OAuthError).code).toBe("temporarily_unavailable");
	});

	it("never goes below a one-minute token lifetime", () => {
		expect(accessTokenTtl(Date.now() - 10_000)).toBe(60);
	});
});

describe("getGoogleAccessToken", () => {
	let fetchSpy: MockInstance<typeof fetch>;

	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, "fetch");
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns the stored token while it's still fresh", async () => {
		const result = await getGoogleAccessToken(testAuth(), testEnv());
		expect(result).toEqual({ ok: true, accessToken: "google-access-token" });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("refreshes an expired token for the current call", async () => {
		fetchSpy.mockResolvedValue(jsonResponse({ access_token: "fresh-at", expires_in: 3599 }));
		const result = await getGoogleAccessToken(
			testAuth({ googleExpiresAt: Date.now() - 1 }),
			testEnv(),
		);
		expect(result).toEqual({ ok: true, accessToken: "fresh-at" });
	});

	it("asks the user to reconnect when access was revoked", async () => {
		fetchSpy.mockResolvedValue(jsonResponse({ error: "invalid_grant" }, 400));
		const result = await getGoogleAccessToken(testAuth({ googleExpiresAt: 0 }), testEnv());
		expect(result).toEqual({ ok: false, reason: "needs_reconnect" });
	});

	it("has short, speakable failure replies", () => {
		Object.values(GOOGLE_ACCESS_FAILURE_REPLIES).forEach(expectSpeakableText);
	});
});
