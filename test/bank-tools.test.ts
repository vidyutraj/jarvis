import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSpendingRoute } from "../src/bank/spending-page";
import { decryptSecret, signPageToken, verifyPageToken } from "../src/lib/secret-box";
import { connectBankTool } from "../src/tools/connect-bank";
import { spendingTool } from "../src/tools/spending";
import { spendingPageTool } from "../src/tools/spending-page";
import { expectSpeakable, jsonResponse, resultText, testAuth } from "./helpers";
import { bankEnv, mockApis, plaidError, resetBankTables, seedItem, seedTransactions, tx } from "./bank-helpers";

function context(overrides: Partial<Env> = {}) {
	const { env: e, sent } = bankEnv({ TIME_ZONE: "America/New_York", ...overrides });
	return { ctx: { env: e, auth: testAuth() }, sent };
}

const hostedLink = () =>
	jsonResponse({
		link_token: "link-sandbox-new",
		hosted_link_url: "https://secure.plaid.com/hl/abc?x=1&y=2",
		expiration: "2026-11-01T13:00:00Z",
		request_id: "r",
	});

describe("jarvis_connect_bank", () => {
	beforeEach(async () => {
		await resetBankTables();
		vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => vi.restoreAllMocks());

	it("creates a Hosted Link session for transactions with 2 years of history and sends it to Telegram", async () => {
		const api = mockApis({ "/link/token/create": hostedLink });
		const { ctx } = context();
		const result = await connectBankTool.handler({ mode: "new" }, ctx);

		expect(resultText(result)).toContain("sent a secure sign-in link to your Telegram");
		expectSpeakable(result);
		expect(resultText(result)).not.toContain("plaid.com");

		const call = api.calls[0]!;
		expect(call.path).toBe("/link/token/create");
		expect(call.headers.get("PLAID-CLIENT-ID")).toBe("test-plaid-client-id");
		expect(call.body).toEqual({
			client_name: "Jarvis",
			language: "en",
			country_codes: ["US"],
			user: { client_user_id: "google-sub-123" },
			products: ["transactions"],
			transactions: { days_requested: 730 },
			hosted_link: { url_lifetime_seconds: 3600 },
			webhook: "https://jarvis.test/plaid/webhook",
		});
		// The URL goes to Telegram, escaped for HTML.
		expect(api.telegram[0]).toContain('href="https://secure.plaid.com/hl/abc?x=1&amp;y=2"');
		// The session is stored so the hourly check can finish it; the link token only encrypted.
		const row = await env.DB.prepare("SELECT * FROM bank_link_sessions").first<{ link_token_enc: string; item_id: string | null }>();
		expect(row?.item_id).toBeNull();
		expect(row?.link_token_enc).not.toContain("link-sandbox-new");
		expect(await decryptSecret(env.JARVIS_SECRET_KEY, "plaid-link-token", row!.link_token_enc)).toBe("link-sandbox-new");
	});

	it("leaves out the webhook when the Worker URL isn't https (local dev)", async () => {
		const api = mockApis({ "/link/token/create": hostedLink });
		const { ctx } = context({ MCP_RESOURCE: "http://localhost:8787/mcp" });
		await connectBankTool.handler({ mode: "new" }, ctx);
		expect(api.calls[0]!.body).not.toHaveProperty("webhook");
	});

	it("won't start a second connection to a bank that's already connected", async () => {
		await seedItem({ name: "PNC" });
		const api = mockApis({});
		const { ctx } = context();
		const result = await connectBankTool.handler({ mode: "new", bank: "p.n.c." }, ctx);
		expect(resultText(result)).toBe("PNC is already connected. If it's not working, ask me to reconnect it.");
		expect(api.calls).toHaveLength(0);
	});

	it("reconnect uses update mode: the existing access token and no products", async () => {
		await seedItem({ name: "Barclays - Cards", institutionId: "ins_barclays", status: "login_required", accessToken: "access-barclays" });
		const api = mockApis({ "/link/token/create": hostedLink });
		const { ctx } = context();
		const result = await connectBankTool.handler({ mode: "reconnect", bank: "barclays" }, ctx);
		expect(result.isError).toBeUndefined();
		const body = api.calls[0]!.body;
		expect(body.access_token).toBe("access-barclays");
		expect(body).not.toHaveProperty("products");
		expect(body).not.toHaveProperty("transactions");
		const row = await env.DB.prepare("SELECT item_id FROM bank_link_sessions").first();
		expect(row).toEqual({ item_id: "item-1" });
	});

	it("speaks a short error when Plaid refuses or keys are missing", async () => {
		mockApis({ "/link/token/create": () => plaidError("INVALID_REQUEST", "INVALID_FIELD") });
		const refused = await connectBankTool.handler({ mode: "new" }, context().ctx);
		expect(refused.isError).toBe(true);
		expectSpeakable(refused);

		const missing = await connectBankTool.handler({ mode: "new" }, context({ PLAID_SECRET: "" }).ctx);
		expect(resultText(missing)).toBe("The bank connection isn't set up yet, so I couldn't start it.");
	});
});

describe("jarvis_spending", () => {
	beforeEach(resetBankTables);
	afterEach(() => vi.restoreAllMocks());

	async function seedOctober() {
		await seedItem();
		await seedTransactions("item-1", [
			tx("food-1", { amount: 40, date: "2026-10-03" }),
			tx("food-2", { amount: 25.5, date: "2026-10-20" }),
			tx("food-refund", { amount: -5.5, date: "2026-10-21" }),
			tx("flight", { amount: 300, date: "2026-10-09", personal_finance_category: { primary: "TRAVEL", confidence_level: "VERY_HIGH" } }),
			// Not spending: the card payment from checking and its credit on the card, a paycheck, a transfer.
			tx("card-payment", { amount: 500, date: "2026-10-25", personal_finance_category: { primary: "LOAN_PAYMENTS", confidence_level: "HIGH" } }),
			tx("card-credit", { amount: -500, date: "2026-10-26", personal_finance_category: { primary: "TRANSFER_IN", confidence_level: "HIGH" } }),
			tx("paycheck", { amount: -2000, date: "2026-10-15", personal_finance_category: { primary: "INCOME", confidence_level: "HIGH" } }),
			tx("guess", { amount: 12, date: "2026-10-11", personal_finance_category: { primary: "ENTERTAINMENT", confidence_level: "LOW" } }),
			tx("september", { amount: 99, date: "2026-09-30" }),
		]);
	}

	it("totals a month's spending by category, excluding transfers, card payments and income", async () => {
		await seedOctober();
		const result = await spendingTool.handler({ from_month: "2026-10" }, context().ctx);
		expect(resultText(result)).toBe(
			"Spending for October 2026: $372 total.\nTop categories: Travel $300, Food and drink $60, Uncategorized $12.",
		);
	});

	it("answers for one category, with refunds netted", async () => {
		await seedOctober();
		const result = await spendingTool.handler({ from_month: "2026-10", category: "FOOD_AND_DRINK" }, context().ctx);
		expect(resultText(result)).toBe("Food and drink in October 2026: $60 across 3 transactions.");
		expectSpeakable(result);
	});

	it("says when nothing is connected, and warns while history is importing", async () => {
		const none = await spendingTool.handler({}, context().ctx);
		expect(resultText(none)).toContain("No bank accounts are connected yet");

		await seedItem({ historical: false });
		const importing = await spendingTool.handler({ from_month: "2026-10" }, context().ctx);
		expect(resultText(importing)).toContain("still importing");
	});

	it("includes today's date in its description so Claude can resolve 'last month'", () => {
		const description = spendingTool.description as (c: unknown) => string;
		expect(description(context().ctx)).toMatch(/Today is .*America\/New_York/);
	});
});

describe("spending page", () => {
	beforeEach(resetBankTables);
	afterEach(() => vi.restoreAllMocks());

	it("sends a 15-minute signed link with the token in the fragment", async () => {
		const api = mockApis({});
		const result = await spendingPageTool.handler({}, context().ctx);
		expectSpeakable(result);
		const href = /href="([^"]+)"/.exec(api.telegram[0]!)![1]!;
		const url = new URL(href);
		expect(url.origin + url.pathname).toBe("https://jarvis.test/spending");
		expect(url.search).toBe("");
		expect(await verifyPageToken(env.JARVIS_SECRET_KEY, url.hash.slice(1))).toBe(true);
	});

	it("serves the shell with a strict CSP, and data only for a valid token", async () => {
		const shell = (await handleSpendingRoute(new Request("https://jarvis.test/spending"), env))!;
		expect(shell.status).toBe(200);
		expect(shell.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
		expect(await shell.text()).not.toContain("<script>");

		const post = (auth?: string) =>
			handleSpendingRoute(
				new Request("https://jarvis.test/spending/data", { method: "POST", headers: auth ? { Authorization: auth } : {} }),
				env,
			);
		expect((await post())!.status).toBe(401);
		expect((await post("Bearer 123.abcdefghijklmnopqrstuvwxyz"))!.status).toBe(401);

		const expired = await signPageToken(env.JARVIS_SECRET_KEY, Math.floor(Date.now() / 1000) - 1);
		expect((await post(`Bearer ${expired}`))!.status).toBe(401);

		await seedItem();
		await seedTransactions("item-1", [tx("t1", { amount: 20, date: new Date().toISOString().slice(0, 10) })]);
		const valid = await signPageToken(env.JARVIS_SECRET_KEY, Math.floor(Date.now() / 1000) + 60);
		const response = (await post(`Bearer ${valid}`))!;
		expect(response.status).toBe(200);
		const data = (await response.json()) as { months: string[]; categories: { label: string }[] };
		expect(data.months).toHaveLength(24);
		expect(data.categories[0]?.label).toBe("Food and drink");
	});

	it("doesn't handle unrelated paths", async () => {
		expect(await handleSpendingRoute(new Request("https://jarvis.test/mcp"), env)).toBeNull();
	});
});
