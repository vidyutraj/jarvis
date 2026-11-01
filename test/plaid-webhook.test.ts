import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handlePlaidWebhook } from "../src/bank/webhook";
import { clearWebhookKeyCache } from "../src/lib/plaid-webhook";
import { sha256Hex } from "../src/lib/secret-box";
import { jsonResponse } from "./helpers";
import { bankEnv, mockApis } from "./bank-helpers";

const KID = "test-kid";

async function signingSetup() {
	const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
		"sign",
		"verify",
	])) as CryptoKeyPair;
	const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
	const key = { alg: "ES256", crv: jwk.crv, kid: KID, kty: jwk.kty, use: "sig", x: jwk.x, y: jwk.y, created_at: 1, expired_at: null };
	const api = mockApis({ "/webhook_verification_key/get": () => jsonResponse({ key, request_id: "r" }) });
	return { privateKey: pair.privateKey, api };
}

async function signedRequest(
	privateKey: CryptoKey,
	body: string,
	options: { iat?: number; hashOf?: string; alg?: string } = {},
): Promise<Request> {
	const jwt = await new SignJWT({ request_body_sha256: await sha256Hex(options.hashOf ?? body) })
		.setProtectedHeader({ alg: "ES256", kid: KID, typ: "JWT" })
		.setIssuedAt(options.iat ?? Math.floor(Date.now() / 1000))
		.sign(privateKey);
	return new Request("https://jarvis.test/plaid/webhook", {
		method: "POST",
		headers: { "Content-Type": "application/json", "Plaid-Verification": jwt },
		body,
	});
}

const syncBody = JSON.stringify(
	{ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "item-1", environment: "sandbox" },
	null,
	2,
);

describe("Plaid webhook receiver", () => {
	beforeEach(() => {
		clearWebhookKeyCache();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
	});
	afterEach(() => vi.restoreAllMocks());

	it("accepts a correctly signed webhook and only enqueues work", async () => {
		const { privateKey, api } = await signingSetup();
		const { env, sent } = bankEnv();
		const response = await handlePlaidWebhook(await signedRequest(privateKey, syncBody), env);
		expect(response.status).toBe(200);
		expect(sent).toEqual([{ kind: "sync_start", itemId: "item-1" }]);
		expect(api.calls.map((c) => c.path)).toEqual(["/webhook_verification_key/get"]);
		expect(api.calls[0]!.body).toEqual({ key_id: KID });
	});

	it("rejects a missing signature, a tampered body, an old token and a non-ES256 token", async () => {
		const { privateKey } = await signingSetup();
		const { env, sent } = bankEnv();

		const unsigned = new Request("https://jarvis.test/plaid/webhook", { method: "POST", body: syncBody });
		expect((await handlePlaidWebhook(unsigned, env)).status).toBe(401);

		const tampered = await signedRequest(privateKey, syncBody, { hashOf: syncBody.replace("item-1", "item-2") });
		expect((await handlePlaidWebhook(tampered, env)).status).toBe(401);

		const old = await signedRequest(privateKey, syncBody, { iat: Math.floor(Date.now() / 1000) - 6 * 60 });
		expect((await handlePlaidWebhook(old, env)).status).toBe(401);

		const hsToken = await new SignJWT({ request_body_sha256: await sha256Hex(syncBody) })
			.setProtectedHeader({ alg: "HS256", kid: KID })
			.setIssuedAt()
			.sign(new TextEncoder().encode("x".repeat(32)));
		const hs = new Request("https://jarvis.test/plaid/webhook", {
			method: "POST",
			headers: { "plaid-verification": hsToken },
			body: syncBody,
		});
		expect((await handlePlaidWebhook(hs, env)).status).toBe(401);

		expect(sent).toEqual([]);
	});

	it("hashes the raw bytes, so re-serialized JSON doesn't verify", async () => {
		const { privateKey } = await signingSetup();
		const { env } = bankEnv();
		const compact = JSON.stringify(JSON.parse(syncBody));
		const request = await signedRequest(privateKey, syncBody, { hashOf: compact });
		expect((await handlePlaidWebhook(request, env)).status).toBe(401);
	});

	it("asks Plaid to retry (503) when the verification key can't be fetched", async () => {
		const { privateKey } = await signingSetup();
		vi.restoreAllMocks();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network"));
		const { env } = bankEnv();
		expect((await handlePlaidWebhook(await signedRequest(privateKey, syncBody), env)).status).toBe(503);
	});

	it("turns SESSION_FINISHED into a link job keyed by the token's hash, never the token", async () => {
		const { privateKey } = await signingSetup();
		const { env, sent } = bankEnv();
		const body = JSON.stringify({
			webhook_type: "LINK",
			webhook_code: "SESSION_FINISHED",
			status: "success",
			link_session_id: "ls-1",
			link_token: "link-sandbox-abc",
			public_tokens: ["public-sandbox-xyz"],
			environment: "sandbox",
		});
		await handlePlaidWebhook(await signedRequest(privateKey, body), env);
		expect(sent).toEqual([{ kind: "complete_link", linkTokenHash: await sha256Hex("link-sandbox-abc") }]);
		expect(JSON.stringify(sent)).not.toContain("public-sandbox");
	});

	it("maps ITEM webhooks and ignores the other environment", async () => {
		const { privateKey } = await signingSetup();
		const { env, sent } = bankEnv();
		const item = JSON.stringify({
			webhook_type: "ITEM",
			webhook_code: "ERROR",
			item_id: "item-1",
			error: { error_code: "ITEM_LOGIN_REQUIRED" },
			environment: "sandbox",
		});
		await handlePlaidWebhook(await signedRequest(privateKey, item), env);
		const prod = syncBody.replace('"sandbox"', '"production"');
		await handlePlaidWebhook(await signedRequest(privateKey, prod), env);
		expect(sent).toEqual([{ kind: "item_event", itemId: "item-1", code: "ERROR", errorCode: "ITEM_LOGIN_REQUIRED" }]);
	});
});
