/**
 * Plaid API client: plain fetch (the Node SDK depends on axios), one function per
 * endpoint Jarvis uses. Every call returns a typed result and never throws.
 *
 * Never log request or response bodies: they carry the client secret, access
 * tokens, public tokens and link tokens. Only request_id and error codes are
 * logged (Plaid support needs request_id).
 */

const BASE_URLS = {
	sandbox: "https://sandbox.plaid.com",
	production: "https://production.plaid.com",
} as const;

export type PlaidEnvironment = keyof typeof BASE_URLS;

const DEFAULT_TIMEOUT_MS = 15_000;
// The first sync after the historical backfill can be several times slower (TXN-024).
const SYNC_TIMEOUT_MS = 60_000;

type PlaidEnv = Pick<Env, "PLAID_CLIENT_ID" | "PLAID_SECRET" | "PLAID_ENV">;

export type PlaidFailure =
	| { ok: false; reason: "not_configured" }
	| { ok: false; reason: "unreachable" }
	| { ok: false; reason: "bad_response"; status: number; requestId?: string }
	| {
			ok: false;
			reason: "api_error";
			status: number;
			errorType: string;
			errorCode: string;
			requestId?: string;
	  };

export type PlaidResult<T> = { ok: true; data: T } | PlaidFailure;

/** The environment Jarvis talks to, or null if PLAID_ENV isn't one of the two real ones. */
export function plaidEnvironment(env: Pick<Env, "PLAID_ENV">): PlaidEnvironment | null {
	const value = env.PLAID_ENV?.trim();
	return value === "sandbox" || value === "production" ? value : null;
}

async function plaidPost<T>(
	env: PlaidEnv,
	path: string,
	body: Record<string, unknown>,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<PlaidResult<T>> {
	const environment = plaidEnvironment(env);
	const clientId = env.PLAID_CLIENT_ID?.trim();
	const secret = env.PLAID_SECRET?.trim();
	if (!environment || !clientId || !secret) return { ok: false, reason: "not_configured" };

	let response: Response;
	try {
		response = await fetch(`${BASE_URLS[environment]}${path}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"PLAID-CLIENT-ID": clientId,
				"PLAID-SECRET": secret,
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (error) {
		const name = error instanceof Error ? error.name : "UnknownError";
		console.error(`Plaid ${path} failed before a response (${name}).`);
		return { ok: false, reason: "unreachable" };
	}

	let payload: Record<string, unknown> | null = null;
	try {
		payload = (await response.json()) as Record<string, unknown>;
	} catch {
		payload = null;
	}
	const requestId = typeof payload?.request_id === "string" ? payload.request_id : undefined;

	if (!response.ok) {
		const errorType = typeof payload?.error_type === "string" ? payload.error_type : null;
		const errorCode = typeof payload?.error_code === "string" ? payload.error_code : null;
		console.error(
			`Plaid ${path} returned HTTP ${response.status}: ${errorType ?? "?"}/${errorCode ?? "?"} request_id=${requestId ?? "none"}`,
		);
		if (errorType && errorCode) {
			return { ok: false, reason: "api_error", status: response.status, errorType, errorCode, requestId };
		}
		return { ok: false, reason: "bad_response", status: response.status, requestId };
	}
	if (!payload) {
		console.error(`Plaid ${path} returned an unreadable body (HTTP ${response.status}).`);
		return { ok: false, reason: "bad_response", status: response.status };
	}
	return { ok: true, data: payload as T };
}

/** True for failures worth retrying later with backoff (ITEM-004, ITEM-008). */
export function isTransientPlaidFailure(failure: PlaidFailure): boolean {
	if (failure.reason === "unreachable") return true;
	if (failure.reason === "bad_response") return failure.status >= 500 || failure.status === 429;
	if (failure.reason !== "api_error") return false;
	return (
		failure.errorType === "RATE_LIMIT_EXCEEDED" ||
		failure.errorType === "API_ERROR" ||
		failure.errorCode === "INSTITUTION_DOWN" ||
		failure.errorCode === "INSTITUTION_NOT_RESPONDING" ||
		failure.errorCode === "INTERNAL_SERVER_ERROR"
	);
}

/** Error codes that mean the user has to sign in to their bank again (update mode). */
export const RECONNECT_ERROR_CODES = new Set([
	"ITEM_LOGIN_REQUIRED",
	"INVALID_CREDENTIALS",
	"ITEM_LOCKED",
	"ACCESS_NOT_GRANTED",
	"INVALID_UPDATED_USERNAME",
	"USER_SETUP_REQUIRED",
	"MFA_NOT_SUPPORTED",
	"NO_ACCOUNTS",
]);

// ---------------------------------------------------------------------------
// Link

export interface HostedLinkToken {
	link_token: string;
	hosted_link_url: string;
	expiration: string;
}

export interface CreateHostedLinkOptions {
	clientUserId: string;
	/** Absent for local development, where Plaid can't reach the Worker. */
	webhookUrl?: string;
	urlLifetimeSeconds: number;
	/** Update mode: re-authenticate this existing Item instead of adding a new one. */
	accessToken?: string;
}

export const TRANSACTIONS_DAYS_REQUESTED = 730;

export function createHostedLinkToken(
	env: PlaidEnv,
	options: CreateHostedLinkOptions,
): Promise<PlaidResult<HostedLinkToken>> {
	const body: Record<string, unknown> = {
		client_name: "Jarvis",
		language: "en",
		country_codes: ["US"],
		user: { client_user_id: options.clientUserId },
		hosted_link: { url_lifetime_seconds: options.urlLifetimeSeconds },
	};
	if (options.accessToken) {
		// Update mode: no products, the existing access token (ITEM-003).
		body.access_token = options.accessToken;
	} else {
		// Transactions only, so credit cards stay eligible (TXN-021); 2 years of
		// history, which can only be set at first initialization (TXN-009).
		body.products = ["transactions"];
		body.transactions = { days_requested: TRANSACTIONS_DAYS_REQUESTED };
		if (options.webhookUrl) body.webhook = options.webhookUrl;
	}
	return plaidPost(env, "/link/token/create", body);
}

export interface LinkTokenGetResponse {
	link_token: string;
	expiration?: string;
	link_sessions?: {
		link_session_id: string;
		finished_at?: string | null;
		exit?: { error?: { error_code?: string } | null } | null;
		results?: {
			item_add_results?: {
				public_token: string;
				institution?: { institution_id?: string | null; name?: string | null } | null;
			}[];
		} | null;
	}[];
}

export function getLinkToken(
	env: PlaidEnv,
	linkToken: string,
): Promise<PlaidResult<LinkTokenGetResponse>> {
	return plaidPost(env, "/link/token/get", { link_token: linkToken });
}

export function exchangePublicToken(
	env: PlaidEnv,
	publicToken: string,
): Promise<PlaidResult<{ access_token: string; item_id: string }>> {
	return plaidPost(env, "/item/public_token/exchange", { public_token: publicToken });
}

// ---------------------------------------------------------------------------
// Items, accounts, institutions

export interface PlaidItem {
	item_id: string;
	institution_id?: string | null;
	error?: { error_code?: string } | null;
}

export function getItem(env: PlaidEnv, accessToken: string): Promise<PlaidResult<{ item: PlaidItem }>> {
	return plaidPost(env, "/item/get", { access_token: accessToken });
}

export function removeItem(env: PlaidEnv, accessToken: string): Promise<PlaidResult<unknown>> {
	return plaidPost(env, "/item/remove", { access_token: accessToken });
}

export interface PlaidAccount {
	account_id: string;
	persistent_account_id?: string | null;
	name: string;
	official_name?: string | null;
	mask?: string | null;
	type: string;
	subtype?: string | null;
}

export function getAccounts(
	env: PlaidEnv,
	accessToken: string,
): Promise<PlaidResult<{ accounts: PlaidAccount[]; item: PlaidItem }>> {
	return plaidPost(env, "/accounts/get", { access_token: accessToken });
}

export function getInstitution(
	env: PlaidEnv,
	institutionId: string,
): Promise<PlaidResult<{ institution: { institution_id: string; name: string } }>> {
	return plaidPost(env, "/institutions/get_by_id", {
		institution_id: institutionId,
		country_codes: ["US"],
	});
}

// ---------------------------------------------------------------------------
// Transactions

export interface PlaidTransaction {
	transaction_id: string;
	account_id: string;
	amount: number;
	iso_currency_code?: string | null;
	unofficial_currency_code?: string | null;
	date: string;
	authorized_date?: string | null;
	name?: string | null;
	merchant_name?: string | null;
	pending: boolean;
	pending_transaction_id?: string | null;
	personal_finance_category?: {
		primary?: string | null;
		detailed?: string | null;
		confidence_level?: string | null;
	} | null;
	payment_channel?: string | null;
}

export interface TransactionsSyncResponse {
	added: PlaidTransaction[];
	modified: PlaidTransaction[];
	removed: { transaction_id: string }[];
	next_cursor: string;
	has_more: boolean;
	transactions_update_status?: string;
	request_id?: string;
}

/** Page size: 250 keeps each Queue invocation well inside the free plan's CPU budget. */
export const SYNC_PAGE_SIZE = 250;

export function syncTransactions(
	env: PlaidEnv,
	accessToken: string,
	cursor: string | null,
): Promise<PlaidResult<TransactionsSyncResponse>> {
	const body: Record<string, unknown> = {
		access_token: accessToken,
		count: SYNC_PAGE_SIZE,
		// Pin the taxonomy so category names never change under us (TXN-006).
		options: { personal_finance_category_version: "v2" },
	};
	if (cursor) body.cursor = cursor;
	return plaidPost(env, "/transactions/sync", body, SYNC_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// Webhook verification keys

export interface PlaidWebhookKey {
	alg: string;
	crv: string;
	kid: string;
	kty: string;
	use: string;
	x: string;
	y: string;
	created_at: number;
	expired_at: number | null;
}

export function getWebhookVerificationKey(
	env: PlaidEnv,
	keyId: string,
): Promise<PlaidResult<{ key: PlaidWebhookKey }>> {
	return plaidPost(env, "/webhook_verification_key/get", { key_id: keyId });
}
