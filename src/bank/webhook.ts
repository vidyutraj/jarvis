import { plaidEnvironment } from "../lib/plaid";
import { verifyPlaidWebhook } from "../lib/plaid-webhook";
import { sha256Hex } from "../lib/secret-box";
import { enqueue, type BankJob } from "./jobs";

/**
 * POST /plaid/webhook. Public so Plaid can reach it, but nothing is trusted until
 * the Plaid-Verification signature checks out. It only enqueues work and answers
 * fast (WEBHOOK-001); webhooks are triggers, never data (WEBHOOK-005).
 *
 * Status codes: 401 for anything unverifiable (Plaid won't retry a forgery),
 * 503 for transient trouble on our side (Plaid retries 5xx for 24 hours).
 */

export const PLAID_WEBHOOK_PATH = "/plaid/webhook";
const MAX_BODY_BYTES = 64 * 1024;

type WebhookEnv = Pick<Env, "BANK_JOBS" | "PLAID_CLIENT_ID" | "PLAID_SECRET" | "PLAID_ENV">;

export async function handlePlaidWebhook(request: Request, env: WebhookEnv): Promise<Response> {
	if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
	const length = Number(request.headers.get("content-length") ?? "0");
	if (length > MAX_BODY_BYTES) return new Response("Too large", { status: 413 });

	const raw = new Uint8Array(await request.arrayBuffer());
	if (raw.byteLength > MAX_BODY_BYTES) return new Response("Too large", { status: 413 });

	const verified = await verifyPlaidWebhook(env, request.headers, raw);
	if (!verified.ok) {
		console.warn(`Rejected a Plaid webhook (${verified.reason}).`);
		return verified.reason === "key_unavailable"
			? new Response("Try again", { status: 503 })
			: new Response("Unauthorized", { status: 401 });
	}

	let payload: Record<string, unknown>;
	try {
		payload = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
	} catch {
		return new Response("Bad request", { status: 400 });
	}

	// Ignore webhooks meant for the other environment (e.g. sandbox Items during testing).
	if (payload.environment !== plaidEnvironment(env)) return new Response("OK");

	const job = await jobFor(payload);
	if (job) {
		try {
			await enqueue(env, job);
		} catch {
			console.error("Couldn't enqueue a Plaid webhook job.");
			return new Response("Try again", { status: 503 });
		}
	}
	return new Response("OK");
}

async function jobFor(payload: Record<string, unknown>): Promise<BankJob | null> {
	const type = payload.webhook_type;
	const code = payload.webhook_code;
	const itemId = typeof payload.item_id === "string" ? payload.item_id : null;

	if (type === "LINK" && code === "SESSION_FINISHED" && typeof payload.link_token === "string") {
		// Public tokens are fetched again from /link/token/get, so none ever sit in the Queue.
		console.log(
			`Hosted Link SESSION_FINISHED (${String(payload.status)}): link_session_id=${String(payload.link_session_id)}`,
		);
		return { kind: "complete_link", linkTokenHash: await sha256Hex(payload.link_token) };
	}
	if (type === "TRANSACTIONS" && code === "SYNC_UPDATES_AVAILABLE" && itemId) {
		return { kind: "sync_start", itemId };
	}
	if (type === "ITEM" && typeof code === "string" && itemId) {
		const error = payload.error as { error_code?: unknown } | null | undefined;
		const errorCode = typeof error?.error_code === "string" ? error.error_code : undefined;
		return { kind: "item_event", itemId, code, ...(errorCode ? { errorCode } : {}) };
	}
	return null; // e.g. ITEM_ADD_RESULT (covered by SESSION_FINISHED) or legacy transactions webhooks
}
