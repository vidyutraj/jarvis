import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from "jose";
import { getWebhookVerificationKey, type PlaidWebhookKey } from "./plaid";

/**
 * Verifies a Plaid webhook (WEBHOOK-003/004): the Plaid-Verification header is an
 * ES256 JWT signed by a key fetched from Plaid by `kid`; its `iat` must be under
 * 5 minutes old and its `request_body_sha256` must equal the SHA-256 of the raw
 * body bytes (never re-serialized JSON).
 */

const MAX_AGE_SECONDS = 5 * 60;

export type WebhookVerification =
	| { ok: true }
	| { ok: false; reason: "missing_header" | "bad_token" | "unknown_key" | "key_unavailable" | "body_mismatch" };

// Keys by kid. Isolates are short-lived, so this only saves repeat fetches within one.
const keyCache = new Map<string, PlaidWebhookKey>();

type VerifyEnv = Pick<Env, "PLAID_CLIENT_ID" | "PLAID_SECRET" | "PLAID_ENV">;

async function webhookKey(env: VerifyEnv, kid: string): Promise<PlaidWebhookKey | "unknown" | "unavailable"> {
	const cached = keyCache.get(kid);
	if (cached) return cached;
	const result = await getWebhookVerificationKey(env, kid);
	if (!result.ok) {
		return result.reason === "api_error" && result.status === 400 ? "unknown" : "unavailable";
	}
	keyCache.set(kid, result.data.key);
	return result.data.key;
}

/** Exposed for tests. */
export function clearWebhookKeyCache(): void {
	keyCache.clear();
}

export async function verifyPlaidWebhook(
	env: VerifyEnv,
	headers: Headers,
	rawBody: Uint8Array,
	nowSeconds = Math.floor(Date.now() / 1000),
): Promise<WebhookVerification> {
	// Headers.get is case-insensitive.
	const token = headers.get("plaid-verification");
	if (!token) return { ok: false, reason: "missing_header" };

	let kid: string;
	try {
		const header = decodeProtectedHeader(token);
		if (header.alg !== "ES256" || typeof header.kid !== "string" || !header.kid) {
			return { ok: false, reason: "bad_token" };
		}
		kid = header.kid;
	} catch {
		return { ok: false, reason: "bad_token" };
	}

	const key = await webhookKey(env, kid);
	if (key === "unknown") return { ok: false, reason: "unknown_key" };
	if (key === "unavailable") return { ok: false, reason: "key_unavailable" };
	// A key past its expired_at has been rotated out.
	if (key.expired_at !== null && key.expired_at <= nowSeconds) {
		keyCache.delete(kid);
		return { ok: false, reason: "unknown_key" };
	}

	let claimedHash: unknown;
	try {
		const publicKey = await importJWK(
			{ kty: key.kty, crv: key.crv, x: key.x, y: key.y } satisfies JWK,
			"ES256",
		);
		const { payload } = await jwtVerify(token, publicKey, {
			algorithms: ["ES256"],
			maxTokenAge: MAX_AGE_SECONDS,
			currentDate: new Date(nowSeconds * 1000),
		});
		claimedHash = payload.request_body_sha256;
	} catch {
		return { ok: false, reason: "bad_token" };
	}
	if (typeof claimedHash !== "string" || !/^[0-9a-f]{64}$/i.test(claimedHash)) {
		return { ok: false, reason: "bad_token" };
	}

	const actual = new Uint8Array(await crypto.subtle.digest("SHA-256", rawBody));
	const claimed = hexToBytes(claimedHash.toLowerCase());
	if (!crypto.subtle.timingSafeEqual(actual, claimed)) {
		return { ok: false, reason: "body_mismatch" };
	}
	return { ok: true };
}

function hexToBytes(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return bytes;
}
