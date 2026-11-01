import { z } from "zod";
import { encryptLinkToken, listItems, matchItemsByName, accessTokenFor, itemDisplayName } from "../bank/store";
import { PLAID_WEBHOOK_PATH } from "../bank/webhook";
import { createHostedLinkToken } from "../lib/plaid";
import { speak, speakError } from "../lib/respond";
import { sha256Hex } from "../lib/secret-box";
import { escapeTelegramHtml, sendTelegramMessage } from "../lib/telegram";
import { defineTool } from "./types";

const LINK_LIFETIME_SECONDS = 60 * 60;

/** Plaid can only call an https Worker URL; local dev relies on the hourly fallback instead. */
function webhookUrl(env: Env): string | undefined {
	try {
		const url = new URL(PLAID_WEBHOOK_PATH, env.MCP_RESOURCE);
		return url.protocol === "https:" ? url.toString() : undefined;
	} catch {
		return undefined;
	}
}

export const connectBankTool = defineTool({
	name: "jarvis_connect_bank",
	description:
		"Connect a bank or credit card account to Jarvis, or reconnect one whose login stopped working, so its " +
		"transactions are imported automatically. Sends a secure Plaid sign-in link to the user's Telegram; the user " +
		"opens it and signs in to their bank themselves. Use when the user asks to connect, link or add a bank or card, " +
		"or to reconnect or fix one (e.g. after Jarvis said a bank needs signing in again). Never read the link aloud.",
	inputSchema: z.object({
		mode: z
			.enum(["new", "reconnect"])
			.describe("'new' to add a bank not yet connected; 'reconnect' to fix an existing connection."),
		bank: z
			.string()
			.trim()
			.max(60)
			.optional()
			.describe("The bank's name as the user said it, e.g. 'PNC' or 'Barclays'. Required for reconnect."),
	}),
	annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
	handler: async ({ mode, bank }, { env, auth }) => {
		const items = (await listItems(env.DB)).filter((item) => item.status !== "revoked");
		const matches = bank ? matchItemsByName(items, bank) : [];

		let accessToken: string | undefined;
		let itemId: string | null = null;
		if (mode === "reconnect") {
			const candidates = bank ? matches : items.filter((item) => item.status !== "ok");
			if (candidates.length !== 1) {
				return speakError(
					candidates.length === 0
						? "I couldn't find that bank among your connections. Which bank should I reconnect?"
						: "More than one bank matches. Which one should I reconnect?",
				);
			}
			const item = candidates[0]!;
			const token = await accessTokenFor(env, item);
			if (!token) return speakError("That connection can't be repaired, so connect the bank again as new.");
			accessToken = token;
			itemId = item.item_id;
		} else if (matches.length > 0) {
			const item = matches[0]!;
			return speak(
				item.status === "ok"
					? `${itemDisplayName(item)} is already connected. If it's not working, ask me to reconnect it.`
					: `${itemDisplayName(item)} is already connected but needs a sign-in. Want me to reconnect it?`,
			);
		}

		const created = await createHostedLinkToken(env, {
			clientUserId: auth.sub,
			webhookUrl: webhookUrl(env),
			urlLifetimeSeconds: LINK_LIFETIME_SECONDS,
			...(accessToken ? { accessToken } : {}),
		});
		if (!created.ok) {
			return speakError(
				created.reason === "not_configured"
					? "The bank connection isn't set up yet, so I couldn't start it."
					: "Plaid didn't start the bank connection. Try again in a moment.",
			);
		}

		const { link_token: linkToken, hosted_link_url: url, expiration } = created.data;
		await env.DB.prepare(
			"INSERT OR IGNORE INTO bank_link_sessions (link_token_hash, link_token_enc, item_id, expires_at) VALUES (?, ?, ?, ?)",
		)
			.bind(await sha256Hex(linkToken), await encryptLinkToken(env, linkToken), itemId, expiration)
			.run();

		const what = itemId ? "reconnect your bank" : "add a bank account";
		const sent = await sendTelegramMessage(
			env,
			`<b>Jarvis bank connection</b>\n\nOpen this link to ${what}. You'll sign in on Plaid's and your bank's ` +
				`own pages; Jarvis never sees your password. The link works for one hour.\n\n` +
				`<a href="${escapeTelegramHtml(url)}">Open secure sign-in</a>`,
		);
		if (!sent.ok) return speakError("I couldn't send the sign-in link to Telegram. Try again in a moment.");

		return speak(
			"I sent a secure sign-in link to your Telegram. Open it and sign in to your bank, and I'll message you when it's connected.",
		);
	},
});
