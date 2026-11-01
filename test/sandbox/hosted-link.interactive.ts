import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { BankJob } from "../../src/bank/jobs";
import { completeLink } from "../../src/bank/link";
import { accessTokenFor, decryptLinkToken, listItems } from "../../src/bank/store";
import { getLinkToken } from "../../src/lib/plaid";
import { startSync, syncPage } from "../../src/bank/sync";
import { removeItem } from "../../src/lib/plaid";
import { connectBankTool } from "../../src/tools/connect-bank";
import { resultText, testAuth } from "../helpers";
import { fakeQueue, resetBankTables } from "../bank-helpers";

/**
 * Interactive Hosted Link check (`npm run test:hosted-link`): sends a real Sandbox
 * Hosted Link to the owner's Telegram, waits up to 5 minutes for them to finish it
 * (pick "Platypus OAuth Bank" to exercise OAuth), then completes it exactly like
 * the hourly fallback does and imports the transactions.
 */

const isSandbox = env.PLAID_ENV === "sandbox" && !!env.PLAID_SECRET && !!env.JARVIS_SECRET_KEY;

describe.skipIf(!isSandbox)("Hosted Link in Sandbox (interactive)", () => {
	it("owner completes the Telegram link; Jarvis stores and syncs the bank", async () => {
		await resetBankTables();
		const { sent, queue } = fakeQueue();
		const e = { ...env, BANK_JOBS: queue } as Env;

		const reply = await connectBankTool.handler({ mode: "new" }, { env: e, auth: testAuth() });
		console.info(`tool reply: ${resultText(reply)}`);
		expect(reply.isError).toBeUndefined();
		const session = await env.DB.prepare("SELECT link_token_hash FROM bank_link_sessions").first<{ link_token_hash: string }>();

		const sealed = await env.DB.prepare("SELECT link_token_enc FROM bank_link_sessions").first<{ link_token_enc: string }>();
		const linkToken = (await decryptLinkToken(env, sealed!.link_token_enc))!;
		let lastShape = "";
		for (let i = 0; i < 30; i++) {
			// Diagnostic: the shape of Plaid's session record (no tokens printed).
			const raw = await getLinkToken(env, linkToken);
			const shape = raw.ok
				? JSON.stringify(
						(raw.data.link_sessions ?? []).map((s) => ({
							keys: Object.keys(s).sort(),
							finished: !!s.finished_at,
							items: s.results?.item_add_results?.length ?? 0,
							exit: !!s.exit,
						})),
					)
				: `error ${raw.reason}`;
			if (shape !== lastShape) console.info(`plaid sessions: ${shape}`);
			lastShape = shape;
			await completeLink(e, session!.link_token_hash);
			const row = await env.DB.prepare("SELECT status, link_session_id FROM bank_link_sessions").first<{ status: string; link_session_id: string | null }>();
			if (row?.status !== "pending") {
				console.info(`session ${row?.status}, link_session_id=${row?.link_session_id}`);
				break;
			}
			await new Promise((r) => setTimeout(r, 10_000));
		}

		const items = await listItems(env.DB);
		console.info(`banks stored: ${items.map((i) => i.institution_name).join(", ") || "none"}`);
		expect(items.length).toBeGreaterThan(0);

		for (let round = 0; round < 10 && !(await listItems(env.DB)).every((i) => i.historical_complete); round++) {
			for (const item of items) sent.push({ kind: "sync_start", itemId: item.item_id });
			for (let guard = 0; sent.length > 0 && guard < 100; guard++) {
				const job = sent.shift() as BankJob;
				if (job.kind === "sync_start") await startSync(e, job.itemId);
				else if (job.kind === "sync_page") await syncPage(e, job.itemId, job.runId, job.step);
			}
			await new Promise((r) => setTimeout(r, 4000));
		}
		const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM bank_transactions").first<{ n: number }>();
		console.info(`transactions imported: ${count?.n}`);
		expect(count?.n).toBeGreaterThan(0);

		for (const item of await listItems(env.DB)) {
			const token = await accessTokenFor(env, item);
			if (token) await removeItem(env, token);
		}
	});
});
