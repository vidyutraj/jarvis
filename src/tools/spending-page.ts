import { z } from "zod";
import { SPENDING_PATH } from "../bank/spending-page";
import { speak, speakError } from "../lib/respond";
import { signPageToken } from "../lib/secret-box";
import { escapeTelegramHtml, sendTelegramMessage } from "../lib/telegram";
import { defineTool } from "./types";

export const PAGE_LINK_MINUTES = 15;

export const spendingPageTool = defineTool({
	name: "jarvis_spending_page",
	description:
		"Send the user a private link (to their Telegram) to their spending page: a table and chart of spending " +
		"by category and month over the last two years, from their connected bank transactions. Use when the user " +
		"wants to see, view or open their spending page, chart, dashboard or breakdown. The link expires after " +
		`${PAGE_LINK_MINUTES} minutes. Never read the link aloud.`,
	inputSchema: z.object({}),
	annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
	handler: async (_args, { env }) => {
		let link: string;
		try {
			const expires = Math.floor(Date.now() / 1000) + PAGE_LINK_MINUTES * 60;
			const token = await signPageToken(env.JARVIS_SECRET_KEY, expires);
			// The token rides in the fragment, which browsers never send to the server.
			link = `${new URL(SPENDING_PATH, env.MCP_RESOURCE).toString()}#${token}`;
		} catch {
			return speakError("The spending page isn't set up yet, so I couldn't send a link.");
		}

		const sent = await sendTelegramMessage(
			env,
			`<b>Your spending page</b>\n\n<a href="${escapeTelegramHtml(link)}">Open spending by category and month</a>\n` +
				`The link works for ${PAGE_LINK_MINUTES} minutes.`,
		);
		if (!sent.ok) return speakError("I couldn't send the link to Telegram. Try again in a moment.");
		return speak(`I sent your spending page to Telegram. The link works for ${PAGE_LINK_MINUTES} minutes.`);
	},
});
