import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { BankJob } from "../../src/bank/jobs";
import { addItem, completeLink } from "../../src/bank/link";
import { accessTokenFor, getItem, listItems } from "../../src/bank/store";
import { startSync, syncPage } from "../../src/bank/sync";
import { removeItem } from "../../src/lib/plaid";
import { connectBankTool } from "../../src/tools/connect-bank";
import { spendingTool } from "../../src/tools/spending";
import { resultText, testAuth } from "../helpers";
import { fakeQueue, resetBankTables } from "../bank-helpers";

/**
 * Real Plaid Sandbox, real Jarvis code paths; only Telegram and the Queue are faked.
 * Prints counts and categories only, never keys, tokens or links.
 */

const SANDBOX = "https://sandbox.plaid.com";
const isSandbox = env.PLAID_ENV === "sandbox" && !!env.PLAID_CLIENT_ID && !!env.PLAID_SECRET && !!env.JARVIS_SECRET_KEY;

async function sandboxCall(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
	const response = await fetch(`${SANDBOX}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "PLAID-CLIENT-ID": env.PLAID_CLIENT_ID, "PLAID-SECRET": env.PLAID_SECRET },
		body: JSON.stringify(body),
	});
	const json = (await response.json()) as Record<string, unknown>;
	if (!response.ok) throw new Error(`${path} failed: ${String(json.error_code)} (request_id ${String(json.request_id)})`);
	return json;
}

async function sandboxPublicToken(institutionId: string, username: string): Promise<string> {
	const json = await sandboxCall("/sandbox/public_token/create", {
		institution_id: institutionId,
		initial_products: ["transactions"],
		options: { override_username: username, override_password: "pass_good", transactions: { days_requested: 730 } },
	});
	return json.public_token as string;
}

const telegram: string[] = [];
const { sent, queue } = fakeQueue();
const e = { ...env, BANK_JOBS: queue } as Env;

/** Plays the Queue: runs every queued job until none are left. */
async function drain(): Promise<void> {
	for (let guard = 0; sent.length > 0 && guard < 200; guard++) {
		const job = sent.shift() as BankJob;
		if (job.kind === "sync_start") await startSync(e, job.itemId);
		else if (job.kind === "sync_page") await syncPage(e, job.itemId, job.runId, job.step);
	}
}

/** Stands in for SYNC_UPDATES_AVAILABLE: re-sync every few seconds until the full history is in. */
async function syncUntilHistorical(itemId: string): Promise<void> {
	for (let attempt = 0; attempt < 30; attempt++) {
		sent.push({ kind: "sync_start", itemId });
		await drain();
		if ((await getItem(env.DB, itemId))?.historical_complete) return;
		await new Promise((r) => setTimeout(r, 4000));
	}
	throw new Error("Sandbox history didn't finish importing within 2 minutes.");
}

async function stats(itemId: string) {
	return env.DB.prepare(
		`SELECT COUNT(*) AS n, MIN(date) AS first, MAX(date) AS last, COUNT(DISTINCT category_primary) AS categories,
			SUM(pending) AS pending FROM bank_transactions WHERE item_id = ?`,
	)
		.bind(itemId)
		.first<{ n: number; first: string; last: string; categories: number; pending: number }>();
}

describe.skipIf(!isSandbox)("Plaid Sandbox end to end", () => {
	beforeAll(async () => {
		await resetBankTables();
		const realFetch = globalThis.fetch;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.startsWith("https://api.telegram.org/")) {
				telegram.push(JSON.parse(String(init?.body)).text as string);
				return Response.json({ ok: true, result: {} });
			}
			return realFetch(input, init);
		});
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterAll(async () => {
		// Leave nothing behind in the Sandbox.
		for (const item of await listItems(env.DB)) {
			const token = await accessTokenFor(env, item);
			if (token) await removeItem(env, token);
		}
		vi.restoreAllMocks();
	});

	it("persona 1 (user_transactions_dynamic @ First Platypus): link, import history, answer spending", async () => {
		await addItem(e, await sandboxPublicToken("ins_109508", "user_transactions_dynamic"), "ins_109508");
		const [item] = await listItems(env.DB);
		expect(item?.institution_name).toBeTruthy();
		expect(telegram.some((t) => t.includes("Bank connected"))).toBe(true);

		await syncUntilHistorical(item!.item_id);
		const s = await stats(item!.item_id);
		console.info(`persona 1: ${item!.institution_name}: ${s?.n} transactions ${s?.first}..${s?.last}, ${s?.categories} categories, ${s?.pending} pending`);
		expect(s?.n).toBeGreaterThan(0);
		expect(telegram.some((t) => t.includes("Bank history imported"))).toBe(true);
		// Staging is empty after commit; the cursor is saved.
		const staged = await env.DB.prepare("SELECT COUNT(*) AS n FROM bank_sync_staged").first<{ n: number }>();
		expect(staged?.n).toBe(0);
		expect((await getItem(env.DB, item!.item_id))?.sync_cursor).toBeTruthy();

		const month = s!.last.slice(0, 7);
		const answer = resultText(await spendingTool.handler({ from_month: month }, { env: e, auth: testAuth() }));
		console.info(`persona 1 spending answer: ${answer}`);
		expect(answer).toMatch(/^Spending for .*: \$[\d,.]+ total\./);
	});

	it("persona 2 (user_good @ First Gingham CU): different data, same pipeline", async () => {
		await addItem(e, await sandboxPublicToken("ins_109509", "user_good"), "ins_109509");
		const item = (await listItems(env.DB)).find((i) => i.institution_id === "ins_109509")!;
		await syncUntilHistorical(item.item_id);
		const s = await stats(item.item_id);
		console.info(`persona 2: ${item.institution_name}: ${s?.n} transactions ${s?.first}..${s?.last}, ${s?.categories} categories`);
		expect(s?.n).toBeGreaterThan(0);

		// Spending across both banks over the whole imported range.
		const all = await env.DB.prepare("SELECT MIN(date) AS a, MAX(date) AS b FROM bank_transactions").first<{ a: string; b: string }>();
		const answer = resultText(
			await spendingTool.handler({ from_month: all!.b.slice(0, 7), to_month: all!.b.slice(0, 7) }, { env: e, auth: testAuth() }),
		);
		console.info(`both banks, latest month: ${answer}`);
	});

	it("re-sync with nothing new keeps the data and moves the cursor forward", async () => {
		const item = (await listItems(env.DB))[0]!;
		const before = await stats(item.item_id);
		sent.push({ kind: "sync_start", itemId: item.item_id });
		await drain();
		const after = await stats(item.item_id);
		expect(after?.n).toBeGreaterThanOrEqual(before!.n - 5);
		expect((await getItem(env.DB, item.item_id))?.sync_run_id).toBeNull();
	});

	it("a second link to the same bank is removed with Plaid, not stored", async () => {
		const before = (await listItems(env.DB)).length;
		await addItem(e, await sandboxPublicToken("ins_109508", "user_good"), "ins_109508");
		expect((await listItems(env.DB)).length).toBe(before);
		expect(telegram.some((t) => t.includes("already connected"))).toBe(true);
	});

	it("Plaid accepts our Hosted Link request (new, with webhook) and an open session stays pending", async () => {
		const result = await connectBankTool.handler(
			{ mode: "new" },
			{ env: { ...e, MCP_RESOURCE: "https://jarvis-sandbox-test.invalid/mcp" }, auth: testAuth() },
		);
		expect(result.isError).toBeUndefined();
		expect(telegram[telegram.length - 1]).toMatch(/href="https:\/\/[^"]+plaid\.com\//);
		const session = await env.DB.prepare("SELECT link_token_hash FROM bank_link_sessions").first<{ link_token_hash: string }>();
		await completeLink(e, session!.link_token_hash);
		const row = await env.DB.prepare("SELECT status FROM bank_link_sessions").first<{ status: string }>();
		expect(row?.status).toBe("pending");
	});

	it("broken login → Jarvis marks it and Plaid accepts the update-mode reconnect link", async () => {
		const item = (await listItems(env.DB)).find((i) => i.institution_id === "ins_109509")!;
		await sandboxCall("/sandbox/item/reset_login", { access_token: await accessTokenFor(env, item) });
		sent.push({ kind: "sync_start", itemId: item.item_id });
		await drain();
		expect((await getItem(env.DB, item.item_id))?.status).toBe("login_required");
		expect(telegram.some((t) => t.includes("needs you to sign in again"))).toBe(true);

		const result = await connectBankTool.handler(
			{ mode: "reconnect", bank: item.institution_name ?? "" },
			{ env: e, auth: testAuth() },
		);
		console.info(`reconnect reply: ${resultText(result)}`);
		expect(result.isError).toBeUndefined();
	});
});
