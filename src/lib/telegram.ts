const TELEGRAM_API_BASE = "https://api.telegram.org";
const REQUEST_TIMEOUT_MS = 10_000;

/** Telegram rejects messages longer than this (after entity parsing). */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

export type TelegramSendResult =
	| { ok: true }
	| { ok: false; reason: "not_configured" | "rejected" | "unreachable" };

type TelegramEnv = Pick<Env, "TELEGRAM_BOT_TOKEN" | "TELEGRAM_CHAT_ID">;

/** Escapes text for Telegram's HTML parse mode so user content can't inject or break formatting. */
export function escapeTelegramHtml(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Sends an HTML-formatted message to the configured chat. Never throws: callers
 * get a typed result so they can choose a spoken reply.
 *
 * The request URL contains the bot token, so it is never logged.
 */
export async function sendTelegramMessage(
	env: TelegramEnv,
	html: string,
): Promise<TelegramSendResult> {
	const token = env.TELEGRAM_BOT_TOKEN?.trim();
	const chatId = env.TELEGRAM_CHAT_ID?.trim();
	if (!token || !chatId) {
		return { ok: false, reason: "not_configured" };
	}

	let response: Response;
	try {
		response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				chat_id: chatId,
				text: html,
				parse_mode: "HTML",
				link_preview_options: { is_disabled: true },
			}),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch (error) {
		const name = error instanceof Error ? error.name : "UnknownError";
		console.error(`Telegram request failed before a response (${name}).`);
		return { ok: false, reason: "unreachable" };
	}

	const payload = await readTelegramPayload(response);
	if (!response.ok || payload?.ok !== true) {
		const description = payload?.description ?? "no description";
		console.error(`Telegram rejected sendMessage (HTTP ${response.status}): ${description}`);
		return { ok: false, reason: "rejected" };
	}

	return { ok: true };
}

interface TelegramApiPayload {
	ok?: boolean;
	description?: string;
}

async function readTelegramPayload(response: Response): Promise<TelegramApiPayload | null> {
	try {
		return (await response.json()) as TelegramApiPayload;
	} catch {
		return null;
	}
}
