import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleBankCron, HOURLY_CRON, DAILY_SYNC_CRON } from "../src/bank/consumer";
import { handleItemEvent } from "../src/bank/item-events";
import { completeLink } from "../src/bank/link";
import { accessTokenFor, encryptLinkToken, getItem } from "../src/bank/store";
import { sha256Hex } from "../src/lib/secret-box";
import { jsonResponse } from "./helpers";
import { bankEnv, mockApis, resetBankTables, seedItem } from "./bank-helpers";

async function seedSession(linkToken: string, itemId: string | null = null, expiresAt = "2099-01-01T00:00:00Z") {
	const hash = await sha256Hex(linkToken);
	await env.DB.prepare(
		"INSERT INTO bank_link_sessions (link_token_hash, link_token_enc, item_id, expires_at) VALUES (?, ?, ?, ?)",
	)
		.bind(hash, await encryptLinkToken(env, linkToken), itemId, expiresAt)
		.run();
	return hash;
}

const finishedSession = (publicToken: string, institutionId = "ins_pnc") => () =>
	jsonResponse({
		link_token: "link-sandbox-1",
		link_sessions: [
			{
				link_session_id: "ls-1",
				finished_at: "2026-11-01T12:00:00Z",
				results: { item_add_results: [{ public_token: publicToken, institution: { institution_id: institutionId, name: "PNC" } }] },
			},
		],
	});

const accounts = (itemId: string, institutionId = "ins_pnc") => () =>
	jsonResponse({
		item: { item_id: itemId, institution_id: institutionId },
		accounts: [{ account_id: "acct-1", name: "Checking", mask: "1234", type: "depository", subtype: "checking" }],
	});

async function sessionStatus(hash: string) {
	return (await env.DB.prepare("SELECT status, link_session_id FROM bank_link_sessions WHERE link_token_hash = ?").bind(hash).first())!;
}

describe("Hosted Link completion", () => {
	beforeEach(async () => {
		await resetBankTables();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => vi.restoreAllMocks());

	it("exchanges the public token, stores the bank encrypted, and starts the first sync", async () => {
		const hash = await seedSession("link-sandbox-1");
		const { env: e, sent } = bankEnv();
		const api = mockApis({
			"/link/token/get": finishedSession("public-1"),
			"/item/public_token/exchange": () => jsonResponse({ access_token: "access-new", item_id: "item-new" }),
			"/accounts/get": accounts("item-new"),
			"/institutions/get_by_id": () => jsonResponse({ institution: { institution_id: "ins_pnc", name: "PNC" } }),
		});

		await completeLink(e, hash);

		const item = (await getItem(env.DB, "item-new"))!;
		expect(item).toMatchObject({ institution_id: "ins_pnc", institution_name: "PNC", status: "ok" });
		expect(item.access_token_enc).not.toContain("access-new");
		expect(await accessTokenFor(env, item)).toBe("access-new");
		expect(await env.DB.prepare("SELECT mask FROM bank_accounts WHERE account_id = 'acct-1'").first()).toEqual({ mask: "1234" });
		expect(sent).toEqual([{ kind: "sync_start", itemId: "item-new" }]);
		expect(await sessionStatus(hash)).toEqual({ status: "completed", link_session_id: "ls-1" });
		expect(api.calls.find((c) => c.path === "/item/public_token/exchange")!.body).toEqual({ public_token: "public-1" });
		expect(api.telegram[0]).toContain("PNC is connected (Checking ending 1234)");
	});

	it("is safe to run twice: one bank row, one announcement", async () => {
		const hash = await seedSession("link-sandbox-1");
		await env.DB.prepare("UPDATE bank_link_sessions SET status = 'pending'").run();
		const { env: e } = bankEnv();
		const api = mockApis({
			"/link/token/get": finishedSession("public-1"),
			"/item/public_token/exchange": () => jsonResponse({ access_token: "access-new", item_id: "item-new" }),
			"/accounts/get": accounts("item-new"),
			"/institutions/get_by_id": () => jsonResponse({ institution: { institution_id: "ins_pnc", name: "PNC" } }),
		});
		await completeLink(e, hash);
		await env.DB.prepare("UPDATE bank_link_sessions SET status = 'pending'").run(); // simulate a redelivered job
		await completeLink(e, hash);
		const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM bank_items").first<{ n: number }>();
		expect(count?.n).toBe(1);
		expect(api.telegram).toHaveLength(1);
	});

	it("removes a duplicate connection to a bank that's already linked", async () => {
		await seedItem({ itemId: "item-old", institutionId: "ins_pnc" });
		const hash = await seedSession("link-sandbox-1");
		const { env: e, sent } = bankEnv();
		const api = mockApis({
			"/link/token/get": finishedSession("public-2"),
			"/item/public_token/exchange": () => jsonResponse({ access_token: "access-dup", item_id: "item-dup" }),
			"/accounts/get": accounts("item-dup"),
			"/item/remove": () => jsonResponse({ request_id: "r" }),
		});

		await completeLink(e, hash);

		expect(await getItem(env.DB, "item-dup")).toBeNull();
		expect(api.calls.find((c) => c.path === "/item/remove")!.body).toEqual({ access_token: "access-dup" });
		expect(sent).toEqual([]);
		expect(api.telegram[0]).toContain("already connected");
	});

	it("leaves an unfinished session pending, and expires it after its lifetime", async () => {
		const open = await seedSession("link-open");
		const old = await seedSession("link-old", null, "2020-01-01T00:00:00Z");
		const { env: e } = bankEnv();
		mockApis({ "/link/token/get": () => jsonResponse({ link_token: "x", link_sessions: [] }) });
		await completeLink(e, open);
		await completeLink(e, old);
		expect((await sessionStatus(open)).status).toBe("pending");
		expect((await sessionStatus(old)).status).toBe("expired");
	});

	it("update mode: confirms the repair with /item/get, then resyncs", async () => {
		await seedItem({ status: "login_required" });
		const hash = await seedSession("link-update", "item-1");
		const { env: e, sent } = bankEnv();
		const api = mockApis({
			"/link/token/get": () =>
				jsonResponse({ link_token: "link-update", link_sessions: [{ link_session_id: "ls-2", finished_at: "2026-11-01T12:00:00Z", results: {} }] }),
			"/item/get": () => jsonResponse({ item: { item_id: "item-1", error: null } }),
			"/accounts/get": accounts("item-1"),
		});
		await completeLink(e, hash);
		expect((await getItem(env.DB, "item-1"))?.status).toBe("ok");
		expect(sent).toEqual([{ kind: "sync_start", itemId: "item-1" }]);
		expect(api.calls.some((c) => c.path === "/item/public_token/exchange")).toBe(false);
		expect(api.telegram[0]).toContain("reconnected");
	});
});

describe("item events and crons", () => {
	beforeEach(async () => {
		await resetBankTables();
		vi.spyOn(console, "log").mockImplementation(() => {});
	});
	afterEach(() => vi.restoreAllMocks());

	it("LOGIN_REPAIRED clears the reconnect state and catches up", async () => {
		await seedItem({ status: "login_required" });
		const { env: e, sent } = bankEnv();
		const api = mockApis({});
		await handleItemEvent(e, "item-1", "LOGIN_REPAIRED");
		expect((await getItem(env.DB, "item-1"))?.status).toBe("ok");
		expect(sent).toEqual([{ kind: "sync_start", itemId: "item-1" }]);
		expect(api.telegram[0]).toContain("working again");
	});

	it("PENDING_DISCONNECT warns once; USER_PERMISSION_REVOKED purges the token", async () => {
		await seedItem();
		const { env: e } = bankEnv();
		const api = mockApis({});
		await handleItemEvent(e, "item-1", "PENDING_DISCONNECT");
		await handleItemEvent(e, "item-1", "PENDING_DISCONNECT");
		expect(api.telegram).toHaveLength(1);
		await handleItemEvent(e, "item-1", "USER_PERMISSION_REVOKED");
		expect(await getItem(env.DB, "item-1")).toMatchObject({ status: "revoked", access_token_enc: "" });
	});

	it("hourly cron re-checks pending Link sessions; daily cron syncs every live bank", async () => {
		await seedItem({ itemId: "item-1" });
		await seedItem({ itemId: "item-2", institutionId: "ins_barclays", status: "login_required" });
		const hash = await seedSession("link-pending");
		const hourly = bankEnv();
		await handleBankCron(HOURLY_CRON, hourly.env);
		expect(hourly.sent).toEqual([{ kind: "complete_link", linkTokenHash: hash }]);

		const daily = bankEnv();
		await handleBankCron(DAILY_SYNC_CRON, daily.env);
		expect(daily.sent).toContainEqual({ kind: "sync_start", itemId: "item-1" });
		expect(daily.sent).not.toContainEqual({ kind: "sync_start", itemId: "item-2" });
	});
});
