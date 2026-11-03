import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleBankCron, HOURLY_CRON } from "../src/bank/consumer";
import type { BankJob } from "../src/bank/jobs";
import { handleSpendingRoute } from "../src/bank/spending-page";
import { startSync, syncPage } from "../src/bank/sync";
import { signPageToken } from "../src/lib/secret-box";
import { accountsTool } from "../src/tools/accounts";
import { spendingTool } from "../src/tools/spending";
import { transactionsTool } from "../src/tools/transactions";
import { jsonResponse, resultText, testAuth } from "./helpers";
import { bankEnv, mockApis, resetBankTables, seedItem, tx } from "./bank-helpers";

const accountsResponse = () =>
	jsonResponse({
		item: { item_id: "item-1", institution_id: "ins_pnc" },
		accounts: [
			{ account_id: "chk", name: "Checking", mask: "1234", type: "depository", subtype: "checking", balances: { current: 2345.67, available: 2300, limit: null, iso_currency_code: "USD" } },
			{ account_id: "card", name: "Frontier Card", mask: "9876", type: "credit", subtype: "credit card", balances: { current: 812.4, available: 4187.6, limit: 5000, iso_currency_code: "USD" } },
		],
	});

const rich = [
	tx("coffee-1", {
		account_id: "card",
		amount: 6.45,
		date: "2026-10-28",
		datetime: "2026-10-28T08:15:00Z",
		merchant_name: "Starbucks",
		name: "STARBUCKS 123",
		original_description: "STARBUCKS STORE 00123 PITTSBURGH PA",
		personal_finance_category: { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_COFFEE", confidence_level: "VERY_HIGH" },
		location: { city: "Pittsburgh", region: "PA", address: "1 Main St", lat: 40.44, lon: -79.99, store_number: "123" },
		website: "starbucks.com",
		payment_channel: "in store",
	}),
	tx("amazon-1", {
		account_id: "card",
		amount: 45.12,
		date: "2026-10-20",
		merchant_name: "Amazon",
		personal_finance_category: { primary: "GENERAL_MERCHANDISE", detailed: "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES", confidence_level: "HIGH" },
		counterparties: [{ name: "Amazon", type: "marketplace", website: "amazon.com", confidence_level: "HIGH" }],
		payment_channel: "online",
	}),
	tx("amazon-refund", {
		account_id: "card",
		amount: -12,
		date: "2026-10-22",
		merchant_name: "Amazon",
		personal_finance_category: { primary: "GENERAL_MERCHANDISE", detailed: "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES", confidence_level: "HIGH" },
	}),
	tx("paycheck", {
		account_id: "chk",
		amount: -2100,
		date: "2026-10-15",
		merchant_name: null,
		name: "ACME CORP PAYROLL",
		original_description: "ACME CORP DIRECT DEP PPD",
		personal_finance_category: { primary: "INCOME", detailed: "INCOME_WAGES", confidence_level: "VERY_HIGH" },
	}),
	tx("rent", {
		account_id: "chk",
		amount: 1500,
		date: "2026-10-01",
		merchant_name: null,
		name: "CHECK 1043",
		check_number: "1043",
		personal_finance_category: { primary: "RENT_AND_UTILITIES", detailed: "RENT_AND_UTILITIES_RENT", confidence_level: "HIGH" },
	}),
	tx("coffee-2", {
		account_id: "card",
		amount: 5.25,
		date: "2026-09-03",
		merchant_name: "Starbucks",
		personal_finance_category: { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_COFFEE", confidence_level: "LOW" },
		pending: true,
	}),
];

/** Runs a real sync of `rich` so the rows go through the staging and commit path. */
async function seedRich() {
	await seedItem();
	const { env: e, sent } = bankEnv();
	const api = mockApis({
		"/transactions/sync": () =>
			jsonResponse({ added: rich, modified: [], removed: [], next_cursor: "c1", has_more: false, transactions_update_status: "HISTORICAL_UPDATE_COMPLETE" }),
		"/accounts/get": accountsResponse,
	});
	await startSync(e, "item-1");
	const job = sent.shift() as Extract<BankJob, { kind: "sync_page" }>;
	await syncPage(e, job.itemId, job.runId, job.step, new Date("2026-11-02T12:00:00Z"));
	vi.restoreAllMocks();
	return api;
}

const ctx = () => ({ env: bankEnv({ TIME_ZONE: "America/New_York" }).env, auth: testAuth() });
const lines = (text: string) => text.split("\n");

describe("richer transaction detail", () => {
	beforeEach(async () => {
		await resetBankTables();
		vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => vi.restoreAllMocks());

	it("asks Plaid for raw descriptions and stores location, time, website, counterparties and check numbers", async () => {
		const api = await seedRich();
		expect(api.calls[0]!.body.options).toEqual({ personal_finance_category_version: "v2", include_original_description: true });
		const row = await env.DB.prepare("SELECT * FROM bank_transactions WHERE transaction_id = 'coffee-1'").first<Record<string, unknown>>();
		expect(row).toMatchObject({
			original_description: "STARBUCKS STORE 00123 PITTSBURGH PA",
			datetime: "2026-10-28T08:15:00Z",
			location_city: "Pittsburgh",
			location_region: "PA",
			location_lat: 40.44,
			store_number: "123",
			website: "starbucks.com",
			category_detailed: "FOOD_AND_DRINK_COFFEE",
		});
		const amazon = await env.DB.prepare("SELECT counterparties FROM bank_transactions WHERE transaction_id = 'amazon-1'").first<{ counterparties: string }>();
		expect(JSON.parse(amazon!.counterparties)).toEqual([{ name: "Amazon", type: "marketplace", website: "amazon.com", confidence: "HIGH" }]);
	});

	it("refreshes cached balances after each sync", async () => {
		await seedRich();
		const card = await env.DB.prepare("SELECT * FROM bank_accounts WHERE account_id = 'card'").first<Record<string, unknown>>();
		expect(card).toMatchObject({ balance_current: 812.4, balance_available: 4187.6, balance_limit: 5000, balance_as_of: "2026-11-02T12:00:00.000Z" });
	});

	it("hourly cron re-syncs older banks once from an empty cursor, then not again", async () => {
		await seedItem();
		await env.DB.prepare("UPDATE bank_items SET data_version = 1, sync_cursor = 'old'").run();
		const first = bankEnv();
		await handleBankCron(HOURLY_CRON, first.env);
		expect(first.sent).toEqual([{ kind: "sync_start", itemId: "item-1" }]);
		expect(await env.DB.prepare("SELECT sync_cursor, data_version FROM bank_items").first()).toEqual({ sync_cursor: null, data_version: 2 });
		const second = bankEnv();
		await handleBankCron(HOURLY_CRON, second.env);
		expect(second.sent).toEqual([]);
	});
});

describe("jarvis_transactions", () => {
	beforeEach(async () => {
		await resetBankTables();
		vi.spyOn(console, "error").mockImplementation(() => {});
		await seedRich();
	});
	afterEach(() => vi.restoreAllMocks());

	it("lists transactions as structured lines with totals, newest first", async () => {
		const text = resultText(await transactionsTool.handler({}, ctx()));
		const [header, columns, first] = lines(text);
		expect(header).toBe("6 transactions from 2026-09-03 to 2026-10-28: $1,556.82 out, $2,112.00 in.");
		expect(columns).toBe("date | merchant | amount | category | account | details");
		expect(first).toBe(
			'2026-10-28 08:15 | Starbucks | out $6.45 | Food and drink > Coffee | PNC Frontier Card ••9876 | in store; at Pittsburgh, PA; bank text "STARBUCKS STORE 00123 PITTSBURGH PA"',
		);
		expect(text).toContain("ACME CORP PAYROLL | in $2,100.00 | Income > Wages | PNC Checking ••1234");
		expect(text).toContain("check 1043");
		expect(text).toContain("via Amazon");
		expect(text).toContain("pending");
		expect(text).toContain("Food and drink > Coffee (uncertain)");
	});

	it("filters by text, account, direction, amount and sorts by size", async () => {
		const amazon = resultText(await transactionsTool.handler({ text: "amazon" }, ctx()));
		expect(lines(amazon)[0]).toBe('2 transactions (matching "amazon") from 2026-10-20 to 2026-10-22: $45.12 out, $12.00 in.');

		const card = resultText(await transactionsTool.handler({ account: "credit card", direction: "out" }, ctx()));
		expect(lines(card)[0]).toContain("3 transactions");
		expect(lines(card)[0]).toContain("account PNC Frontier Card ••9876");

		const big = resultText(await transactionsTool.handler({ min_amount: 100, sort: "largest" }, ctx()));
		expect(lines(big).slice(2).map((l) => l.split(" | ")[1])).toEqual(["ACME CORP PAYROLL", "CHECK 1043"]);

		const income = resultText(await transactionsTool.handler({ category: "INCOME" }, ctx()));
		expect(lines(income)[0]).toContain("1 transaction ");

		const dated = resultText(await transactionsTool.handler({ from_date: "2026-10-01", to_date: "2026-10-15", spending_only: true }, ctx()));
		expect(lines(dated)[0]).toBe("1 transaction (2026-10-01 to 2026-10-15, spending only) from 2026-10-01 to 2026-10-01: $1,500.00 out, $0.00 in.");
	});

	it("treats LIKE wildcards in search text literally", async () => {
		const text = resultText(await transactionsTool.handler({ text: "%" }, ctx()));
		expect(text).toBe('No transactions found (matching "%").');
	});

	it("says when an account name doesn't match", async () => {
		const text = resultText(await transactionsTool.handler({ account: "chase" }, ctx()));
		expect(text).toBe('I couldn\'t find an account matching "chase".');
	});
});

describe("jarvis_accounts and spending breakdowns", () => {
	beforeEach(async () => {
		await resetBankTables();
		vi.spyOn(console, "error").mockImplementation(() => {});
		await seedRich();
	});
	afterEach(() => vi.restoreAllMocks());

	it("lists balances, credit, history and connection health per account", async () => {
		const text = resultText(await accountsTool.handler({}, ctx()));
		expect(lines(text)).toEqual([
			"account | type | balance | history | connection",
			"PNC Checking ••1234 | checking | balance $2,345.67, available $2,300.00 (as of 2026-11-02) | 2 transactions 2026-10-01 to 2026-10-15 | connected",
			"PNC Frontier Card ••9876 | credit card | owed $812.40, limit $5,000.00, available credit $4,187.60 (as of 2026-11-02) | 4 transactions 2026-09-03 to 2026-10-28 | connected",
		]);
	});

	it("breaks spending down by merchant, subcategory and month", async () => {
		const merchant = resultText(await spendingTool.handler({ from_month: "2026-10", group_by: "merchant" }, ctx()));
		expect(lines(merchant)).toEqual([
			"Spending for October 2026 by merchant: $1,540 total across 3 groups.",
			"merchant | total | transactions",
			"CHECK 1043 | $1,500 | 1",
			"Amazon | $33 | 2",
			"Starbucks | $6.45 | 1",
		]);

		const sub = resultText(await spendingTool.handler({ from_month: "2026-10", group_by: "subcategory" }, ctx()));
		expect(sub).toContain("Food and drink > Coffee | $6.45 | 1");
		expect(sub).toContain("Shopping > Online marketplaces | $33 | 2");

		const months = resultText(await spendingTool.handler({ from_month: "2026-09", to_month: "2026-10", group_by: "month" }, ctx()));
		expect(lines(months).slice(2)).toEqual(["September 2026 | $5.25 | 1", "October 2026 | $1,540 | 4"]);
	});
});

describe("spending page transactions", () => {
	beforeEach(async () => {
		await resetBankTables();
		vi.spyOn(console, "error").mockImplementation(() => {});
		await seedRich();
	});
	afterEach(() => vi.restoreAllMocks());

	const post = async (body: unknown, token?: string) =>
		(await handleSpendingRoute(
			new Request("https://jarvis.test/spending/transactions", {
				method: "POST",
				headers: { Authorization: `Bearer ${token ?? (await signPageToken(env.JARVIS_SECRET_KEY, Math.floor(Date.now() / 1000) + 60))}` },
				body: JSON.stringify(body),
			}),
			env,
		))!;

	it("needs a valid token", async () => {
		expect((await post({}, "nope")).status).toBe(401);
	});

	it("rejects malformed queries", async () => {
		expect((await post({ month: "2026-13" })).status).toBe(400);
		expect((await post({ category: "DROP TABLE" })).status).toBe(400);
		expect((await post({ text: "x".repeat(61) })).status).toBe(400);
		expect((await post({ offset: -1 })).status).toBe(400);
	});

	it("a category cell lists exactly the transactions behind its total", async () => {
		const response = await post({ month: "2026-09", category: "FOOD_AND_DRINK" });
		const data = (await response.json()) as { count: number };
		// The only September coffee is low-confidence, so the table files it under Uncategorized.
		expect(data.count).toBe(0);
		const uncategorized = (await (await post({ month: "2026-09", category: "UNCATEGORIZED" })).json()) as { count: number; totalOut: number };
		expect(uncategorized).toMatchObject({ count: 1, totalOut: 5.25 });

		const october = (await (await post({ month: "2026-10", category: "GENERAL_MERCHANDISE" })).json()) as {
			count: number;
			totalOut: number;
			totalIn: number;
			transactions: { merchant: string; via: string[] }[];
		};
		expect(october).toMatchObject({ count: 2, totalOut: 45.12, totalIn: 12 });
		expect(october.transactions[1]).toMatchObject({ merchant: "Amazon", via: ["Amazon"] });
	});

	it("searches across merchant and bank text", async () => {
		const data = (await (await post({ text: "direct dep" })).json()) as { count: number; transactions: { merchant: string }[] };
		expect(data.count).toBe(1);
		expect(data.transactions[0]!.merchant).toBe("ACME CORP PAYROLL");
	});
});
