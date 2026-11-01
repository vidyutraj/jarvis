import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RetryLater, type BankJob } from "../src/bank/jobs";
import { getItem } from "../src/bank/store";
import { startSync, syncPage } from "../src/bank/sync";
import { jsonResponse } from "./helpers";
import { bankEnv, mockApis, plaidError, resetBankTables, seedItem, transactionIds, tx } from "./bank-helpers";

function page(added: ReturnType<typeof tx>[], options: { next: string; hasMore: boolean; removed?: string[]; modified?: ReturnType<typeof tx>[]; status?: string }) {
	return () =>
		jsonResponse({
			added,
			modified: options.modified ?? [],
			removed: (options.removed ?? []).map((id) => ({ transaction_id: id })),
			next_cursor: options.next,
			has_more: options.hasMore,
			transactions_update_status: options.status ?? "HISTORICAL_UPDATE_COMPLETE",
			request_id: "req-1",
		});
}

/** Runs the queued sync jobs to completion, like the Queue would. */
async function drain(e: Env, sent: BankJob[]): Promise<void> {
	for (let guard = 0; sent.length > 0 && guard < 20; guard++) {
		const job = sent.shift()!;
		if (job.kind === "sync_start") await startSync(e, job.itemId);
		else if (job.kind === "sync_page") await syncPage(e, job.itemId, job.runId, job.step);
	}
}

describe("paged transactions sync", () => {
	beforeEach(async () => {
		await resetBankTables();
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => vi.restoreAllMocks());

	it("stages every page and commits transactions and cursor only at the end", async () => {
		await seedItem({ historical: false });
		const { env: e, sent } = bankEnv();
		const api = mockApis({
			"/transactions/sync": [
				page([tx("t1"), tx("t2")], { next: "c1", hasMore: true }),
				page([tx("t3")], { next: "c2", hasMore: false }),
			],
		});

		await startSync(e, "item-1");
		const first = sent.shift()!;
		expect(first).toMatchObject({ kind: "sync_page", itemId: "item-1", step: 0 });
		await syncPage(e, "item-1", (first as { runId: string }).runId, 0);

		// Mid-run: nothing visible, committed cursor untouched.
		expect(await transactionIds()).toEqual([]);
		expect((await getItem(env.DB, "item-1"))?.sync_cursor).toBeNull();

		await drain(e, sent);
		expect(await transactionIds()).toEqual(["t1", "t2", "t3"]);
		const item = await getItem(env.DB, "item-1");
		expect(item).toMatchObject({ sync_cursor: "c2", sync_run_id: null, historical_complete: 1 });

		// First call omits the cursor; the next one uses the page's next_cursor. Count is set; PFC pinned to v2.
		const bodies = api.calls.map((c) => c.body);
		expect(bodies[0]).not.toHaveProperty("cursor");
		expect(bodies[0]).toMatchObject({ access_token: "access-sandbox-1", count: 250, options: { personal_finance_category_version: "v2" } });
		expect(bodies[1]).toMatchObject({ cursor: "c1" });
		// Owner told when the history import finishes.
		expect(api.telegram.some((t) => t.includes("3 transactions"))).toBe(true);
	});

	it("applies modified and removed, including pending → posted with a new id", async () => {
		await seedItem();
		const { env: e, sent } = bankEnv();
		mockApis({
			"/transactions/sync": [
				page([tx("pending-1", { pending: true }), tx("keep", { amount: 5 })], { next: "c1", hasMore: false }),
				// Next update: pending removed, posted added (different page), keep modified.
				page([], { next: "c2", hasMore: true, removed: ["pending-1"] }),
				page([tx("posted-1", { pending_transaction_id: "pending-1" })], {
					next: "c3",
					hasMore: false,
					modified: [tx("keep", { amount: 7 })],
				}),
			],
		});

		sent.push({ kind: "sync_start", itemId: "item-1" });
		await drain(e, sent);
		expect(await transactionIds()).toEqual(["keep", "pending-1"]);

		sent.push({ kind: "sync_start", itemId: "item-1" });
		await drain(e, sent);
		expect(await transactionIds()).toEqual(["keep", "posted-1"]);
		const keep = await env.DB.prepare("SELECT amount FROM bank_transactions WHERE transaction_id = 'keep'").first<{ amount: number }>();
		expect(keep?.amount).toBe(7);
		expect((await getItem(env.DB, "item-1"))?.sync_cursor).toBe("c3");
	});

	it("restarts from the run's starting cursor on a mutation during pagination", async () => {
		await seedItem();
		await env.DB.prepare("UPDATE bank_items SET sync_cursor = 'start' WHERE item_id = 'item-1'").run();
		const { env: e, sent } = bankEnv();
		const api = mockApis({
			"/transactions/sync": [
				page([tx("stale")], { next: "c1", hasMore: true }),
				() => plaidError("TRANSACTIONS_ERROR", "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION"),
				page([tx("fresh")], { next: "c9", hasMore: false }),
			],
		});

		sent.push({ kind: "sync_start", itemId: "item-1" });
		await drain(e, sent);

		expect(api.calls.map((c) => c.body.cursor)).toEqual(["start", "c1", "start"]);
		// Staged rows from the abandoned pass are discarded.
		expect(await transactionIds()).toEqual(["fresh"]);
		expect((await getItem(env.DB, "item-1"))?.sync_cursor).toBe("c9");
	});

	it("doesn't call history imported while Plaid says complete but nothing has arrived", async () => {
		await seedItem({ historical: false });
		const { env: e, sent } = bankEnv();
		const api = mockApis({
			"/transactions/sync": [page([], { next: "c1", hasMore: false }), page([tx("t1")], { next: "c2", hasMore: false })],
		});

		sent.push({ kind: "sync_start", itemId: "item-1" });
		await drain(e, sent);
		expect((await getItem(env.DB, "item-1"))?.historical_complete).toBe(0);
		expect(api.telegram).toEqual([]);

		sent.push({ kind: "sync_start", itemId: "item-1" });
		await drain(e, sent);
		expect((await getItem(env.DB, "item-1"))?.historical_complete).toBe(1);
		expect(api.telegram[0]).toContain("1 transaction is in Jarvis");
	});

	it("ignores duplicate or stale page deliveries", async () => {
		await seedItem();
		const { env: e, sent } = bankEnv();
		const api = mockApis({ "/transactions/sync": [page([tx("t1")], { next: "c1", hasMore: false })] });

		await startSync(e, "item-1");
		const job = sent.shift() as Extract<BankJob, { kind: "sync_page" }>;
		await syncPage(e, job.itemId, job.runId, job.step);
		await syncPage(e, job.itemId, job.runId, job.step); // redelivered
		await syncPage(e, job.itemId, "some-other-run", 0);

		expect(api.calls).toHaveLength(1);
		expect(await transactionIds()).toEqual(["t1"]);
	});

	it("flags a second sync request while one runs, and runs it after commit", async () => {
		await seedItem();
		const { env: e, sent } = bankEnv();
		mockApis({ "/transactions/sync": [page([tx("t1")], { next: "c1", hasMore: false })] });

		await startSync(e, "item-1");
		await startSync(e, "item-1"); // webhook arrives mid-run
		expect(sent).toHaveLength(1);
		const job = sent.shift() as Extract<BankJob, { kind: "sync_page" }>;
		await syncPage(e, job.itemId, job.runId, job.step);
		expect(sent).toEqual([{ kind: "sync_start", itemId: "item-1" }]);
	});

	it("marks the bank as needing a sign-in on ITEM_LOGIN_REQUIRED and tells the owner once", async () => {
		await seedItem();
		const { env: e, sent } = bankEnv();
		const api = mockApis({ "/transactions/sync": [() => plaidError("ITEM_ERROR", "ITEM_LOGIN_REQUIRED")] });

		sent.push({ kind: "sync_start", itemId: "item-1" });
		await drain(e, sent);
		sent.push({ kind: "sync_start", itemId: "item-1" }); // not syncable any more
		await drain(e, sent);

		const item = await getItem(env.DB, "item-1");
		expect(item).toMatchObject({ status: "login_required", sync_run_id: null });
		expect(api.telegram).toHaveLength(1);
		expect(api.telegram[0]).toContain("reconnect PNC");
		expect(api.calls).toHaveLength(1);
	});

	it("asks the Queue to retry on transient failures, keeping the run", async () => {
		await seedItem();
		const { env: e, sent } = bankEnv();
		mockApis({ "/transactions/sync": [() => plaidError("INSTITUTION_ERROR", "INSTITUTION_DOWN")] });

		await startSync(e, "item-1");
		const job = sent.shift() as Extract<BankJob, { kind: "sync_page" }>;
		await expect(syncPage(e, job.itemId, job.runId, job.step)).rejects.toBeInstanceOf(RetryLater);
		expect((await getItem(env.DB, "item-1"))?.sync_run_id).toBe(job.runId);
	});

	it("revokes the stored token on ITEM_NOT_FOUND but keeps imported history", async () => {
		await seedItem();
		await env.DB.prepare(
			"INSERT INTO bank_transactions (transaction_id, item_id, account_id, amount, date, pending) VALUES ('old', 'item-1', 'a', 1, '2026-01-01', 0)",
		).run();
		const { env: e, sent } = bankEnv();
		mockApis({ "/transactions/sync": [() => plaidError("ITEM_ERROR", "ITEM_NOT_FOUND")] });

		sent.push({ kind: "sync_start", itemId: "item-1" });
		await drain(e, sent);
		expect(await getItem(env.DB, "item-1")).toMatchObject({ status: "revoked", access_token_enc: "" });
		expect(await transactionIds()).toEqual(["old"]);
	});

	it("stores no access token in plain text", async () => {
		await seedItem({ accessToken: "access-sandbox-secret" });
		const row = await env.DB.prepare("SELECT * FROM bank_items").first<Record<string, unknown>>();
		expect(JSON.stringify(row)).not.toContain("access-sandbox-secret");
	});
});
