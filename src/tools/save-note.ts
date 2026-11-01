import { z } from "zod";
import { speak, speakError } from "../lib/respond";
import { escapeTelegramHtml, sendTelegramMessage, type TelegramSendResult } from "../lib/telegram";
import { defineTool } from "./types";

export const NOTE_TITLE_MAX_LENGTH = 100;
// Leaves headroom under Telegram's 4096-character limit for the title and HTML escaping.
export const NOTE_BODY_MAX_LENGTH = 3500;

const FAILURE_REPLIES: Record<Exclude<TelegramSendResult, { ok: true }>["reason"], string> = {
	not_configured: "Telegram isn't set up yet, so I couldn't save that note.",
	rejected: "Telegram didn't accept that note, so it wasn't saved.",
	unreachable: "I couldn't reach Telegram just now. Try again in a moment.",
};

export const saveNoteTool = defineTool({
	name: "save_note",
	description:
		"Save an idea or thought as a note by sending it to the user's Telegram. Use when the user wants to " +
		"remember, jot down or capture something with no specific time attached (use a reminder for timed tasks). " +
		"The user is usually speaking, so first tidy their rambling speech into a clear, concise note: " +
		"remove filler words, repetition and false starts, keep every distinct idea and detail, and use short " +
		"lines or bullets when there are several points. Write in the user's voice; don't add anything they didn't say.",
	inputSchema: z.object({
		title: z
			.string()
			.trim()
			.min(1)
			.max(NOTE_TITLE_MAX_LENGTH)
			.describe(
				"A short, specific title of a few words, e.g. 'App idea: shared grocery list'.",
			),
		body: z
			.string()
			.trim()
			.min(1)
			.max(NOTE_BODY_MAX_LENGTH)
			.describe(
				"The tidied note text. Clear and concise; plain text with line breaks or '-' bullets.",
			),
	}),
	handler: async ({ title, body }, { env }) => {
		const message = `<b>${escapeTelegramHtml(title)}</b>\n\n${escapeTelegramHtml(body)}`;
		const result = await sendTelegramMessage(env, message);
		if (!result.ok) {
			return speakError(FAILURE_REPLIES[result.reason]);
		}
		return speak(`Got it, I sent "${title}" to your Telegram.`);
	},
});
