import { RECONNECT_ERROR_CODES } from "../lib/plaid";
import { escapeTelegramHtml, sendTelegramMessage } from "../lib/telegram";
import { enqueue } from "./jobs";
import { getItem, itemDisplayName, revokeItem, setItemStatus, type ItemStatus } from "./store";

/**
 * ITEM webhooks (WEBHOOK-006) and the Telegram messages that go with them.
 * Messages are sent only when the status actually changes, so retried or
 * duplicate webhooks don't spam the owner.
 */

type EventEnv = Pick<Env, "DB" | "BANK_JOBS" | "TELEGRAM_BOT_TOKEN" | "TELEGRAM_CHAT_ID">;

async function notify(env: EventEnv, html: string): Promise<void> {
	const sent = await sendTelegramMessage(env, html);
	if (!sent.ok) console.error(`Bank notification not delivered (${sent.reason}).`);
}

export async function markNeedsReconnect(
	env: EventEnv,
	itemId: string,
	status: Extract<ItemStatus, "login_required" | "pending_disconnect">,
): Promise<void> {
	const item = await getItem(env.DB, itemId);
	if (!item || item.status === "revoked") return;
	// A broken login outranks an advance warning.
	if (item.status === "login_required" && status === "pending_disconnect") return;
	const previous = await setItemStatus(env.DB, itemId, status);
	if (previous === status) return;
	const bank = escapeTelegramHtml(itemDisplayName(item));
	const why =
		status === "login_required"
			? `${bank} needs you to sign in again before Jarvis can get new transactions.`
			: `${bank}'s connection to Jarvis will expire soon.`;
	await notify(env, `<b>Bank connection</b>\n\n${why} Ask Jarvis to reconnect ${bank}.`);
}

export async function revokeAndNotify(env: EventEnv, itemId: string): Promise<void> {
	const item = await getItem(env.DB, itemId);
	if (!item) return;
	const previous = await revokeItem(env.DB, itemId);
	if (previous === "revoked") return;
	await notify(
		env,
		`<b>Bank connection</b>\n\n${escapeTelegramHtml(itemDisplayName(item))} is no longer connected to Jarvis. ` +
			"Transactions already imported are kept. Ask Jarvis to connect a bank to add it again.",
	);
}

export async function notifyHistoryImported(env: EventEnv, itemId: string): Promise<void> {
	const item = await getItem(env.DB, itemId);
	if (!item) return;
	const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM bank_transactions WHERE item_id = ?")
		.bind(itemId)
		.first<{ n: number }>();
	await notify(
		env,
		`<b>Bank history imported</b>\n\n${escapeTelegramHtml(itemDisplayName(item))}: ` +
			`${row?.n ?? 0} ${row?.n === 1 ? "transaction is" : "transactions are"} in Jarvis. Ask Jarvis about your spending any time.`,
	);
}

export async function handleItemEvent(
	env: EventEnv,
	itemId: string,
	code: string,
	errorCode?: string,
): Promise<void> {
	const item = await getItem(env.DB, itemId);
	if (!item) {
		console.warn(`Item webhook ${code} for an unknown item; ignored.`);
		return;
	}
	switch (code) {
		case "ERROR":
			if (errorCode && RECONNECT_ERROR_CODES.has(errorCode)) {
				await markNeedsReconnect(env, itemId, "login_required");
			} else if (errorCode === "ITEM_NOT_FOUND") {
				await revokeAndNotify(env, itemId);
			} else {
				console.warn(`Item error webhook: ${errorCode ?? "no code"}.`);
			}
			return;
		case "PENDING_DISCONNECT":
		case "PENDING_EXPIRATION":
			await markNeedsReconnect(env, itemId, "pending_disconnect");
			return;
		case "LOGIN_REPAIRED": {
			if (item.status === "revoked") return;
			const previous = await setItemStatus(env.DB, itemId, "ok");
			if (previous !== "ok") {
				await notify(
					env,
					`<b>Bank connection</b>\n\n${escapeTelegramHtml(itemDisplayName(item))} is working again.`,
				);
			}
			// Catch up on everything missed while broken (TXN-015).
			await enqueue(env, { kind: "sync_start", itemId });
			return;
		}
		case "USER_PERMISSION_REVOKED":
			await revokeAndNotify(env, itemId);
			return;
		default:
			// e.g. USER_ACCOUNT_REVOKED, WEBHOOK_UPDATE_ACKNOWLEDGED, NEW_ACCOUNTS_AVAILABLE.
			console.log(`Item webhook ${code} noted; no action.`);
	}
}
