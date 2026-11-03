import { env } from "cloudflare:workers";
import { vi } from "vitest";
import type { BankJob } from "../src/bank/jobs";
import { DATA_VERSION, encryptAccessToken } from "../src/bank/store";
import type { PlaidTransaction } from "../src/lib/plaid";
import { jsonResponse } from "./helpers";

/** A Queue stand-in that records jobs instead of delivering them. */
export function fakeQueue() {
	const sent: BankJob[] = [];
	const queue = {
		send: async (job: BankJob) => {
			sent.push(job);
			return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
		},
		sendBatch: async (messages: Iterable<{ body: BankJob }>) => {
			for (const message of messages) sent.push(message.body);
			return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
		},
		metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }),
	};
	return { sent, queue: queue as unknown as Queue };
}

export function bankEnv(overrides: Partial<Env> = {}) {
	const { sent, queue } = fakeQueue();
	return { sent, env: { ...env, BANK_JOBS: queue, ...overrides } as Env };
}

type PlaidHandler = (body: Record<string, unknown>) => Response | Promise<Response>;

/**
 * Routes mocked fetches: Plaid paths to handlers (a list is consumed in order,
 * the last entry repeating), Telegram always succeeds. Records every call.
 */
export function mockApis(routes: Record<string, PlaidHandler | PlaidHandler[]>) {
	const calls: { path: string; body: Record<string, unknown>; headers: Headers }[] = [];
	const telegram: string[] = [];
	const counters = new Map<string, number>();
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = new URL(String(input instanceof Request ? input.url : input));
		const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
		if (url.hostname === "api.telegram.org") {
			telegram.push(String(body.text));
			return jsonResponse({ ok: true, result: {} });
		}
		calls.push({ path: url.pathname, body, headers: new Headers(init?.headers) });
		const route = routes[url.pathname];
		if (!route) return jsonResponse({ error_type: "INVALID_REQUEST", error_code: "NOT_MOCKED" }, 400);
		if (Array.isArray(route)) {
			const n = counters.get(url.pathname) ?? 0;
			counters.set(url.pathname, n + 1);
			return route[Math.min(n, route.length - 1)]!(body);
		}
		return route(body);
	});
	return { calls, telegram };
}

export function plaidError(errorType: string, errorCode: string, status = 400): Response {
	return jsonResponse({ error_type: errorType, error_code: errorCode, request_id: "req-err" }, status);
}

export function tx(id: string, overrides: Partial<PlaidTransaction> = {}): PlaidTransaction {
	return {
		transaction_id: id,
		account_id: "acct-1",
		amount: 10,
		iso_currency_code: "USD",
		date: "2026-10-15",
		name: `Purchase ${id}`,
		merchant_name: null,
		pending: false,
		personal_finance_category: { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_RESTAURANT", confidence_level: "HIGH" },
		payment_channel: "in store",
		...overrides,
	};
}

/** Inserts an Item (and optionally transactions) straight into D1. */
export async function seedItem(
	options: {
		itemId?: string;
		institutionId?: string;
		name?: string;
		status?: string;
		historical?: boolean;
		accessToken?: string;
	} = {},
): Promise<string> {
	const itemId = options.itemId ?? "item-1";
	await env.DB.prepare(
		`INSERT INTO bank_items (item_id, access_token_enc, institution_id, institution_name, status, historical_complete, data_version)
		VALUES (?, ?, ?, ?, ?, ?, ${DATA_VERSION})`,
	)
		.bind(
			itemId,
			await encryptAccessToken(env, options.accessToken ?? "access-sandbox-1"),
			options.institutionId ?? "ins_pnc",
			options.name ?? "PNC",
			options.status ?? "ok",
			options.historical === false ? 0 : 1,
		)
		.run();
	return itemId;
}

export async function seedTransactions(itemId: string, rows: PlaidTransaction[]): Promise<void> {
	for (const row of rows) {
		await env.DB.prepare(
			`INSERT INTO bank_transactions (transaction_id, item_id, account_id, amount, currency, date, pending,
				category_primary, category_confidence) VALUES (?, ?, ?, ?, 'USD', ?, ?, ?, ?)`,
		)
			.bind(
				row.transaction_id,
				itemId,
				row.account_id,
				row.amount,
				row.date,
				row.pending ? 1 : 0,
				row.personal_finance_category?.primary ?? null,
				row.personal_finance_category?.confidence_level ?? null,
			)
			.run();
	}
}

/** Storage may persist between tests in a file, so start each test empty. */
export async function resetBankTables(): Promise<void> {
	await env.DB.batch(
		["bank_transactions", "bank_accounts", "bank_sync_staged", "bank_sync_removed", "bank_link_sessions", "bank_items"].map(
			(table) => env.DB.prepare(`DELETE FROM ${table}`),
		),
	);
}

export async function transactionIds(itemId = "item-1"): Promise<string[]> {
	const { results } = await env.DB.prepare(
		"SELECT transaction_id FROM bank_transactions WHERE item_id = ? ORDER BY transaction_id",
	)
		.bind(itemId)
		.all<{ transaction_id: string }>();
	return results.map((r) => r.transaction_id);
}
