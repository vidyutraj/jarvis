import { z } from "zod";
import { accountLabel, listAccounts, money } from "../bank/transactions";
import { speak } from "../lib/respond";
import { defineTool } from "./types";

export const accountsTool = defineTool({
	name: "jarvis_accounts",
	description:
		"List the user's connected bank and credit card accounts with balances, credit limits, how much history is " +
		"imported, and whether each connection is healthy. Use for 'what's my checking balance', 'how much do I owe on my card', " +
		"'how much credit do I have left', 'which accounts are connected' or 'is my bank still syncing'. Balances are " +
		"Plaid's latest cached figures (usually updated about once a day), not real-time; say so if the user needs an exact " +
		"figure. One account per line.",
	inputSchema: z.object({}),
	annotations: { readOnlyHint: true },
	handler: async (_args, { env }) => {
		const accounts = await listAccounts(env.DB);
		if (accounts.length === 0) {
			return speak("No bank accounts are connected yet. Ask me to connect your bank to get started.");
		}
		const { results: history } = await env.DB.prepare(
			"SELECT account_id, COUNT(*) AS n, MIN(date) AS first, MAX(date) AS last FROM bank_transactions GROUP BY account_id",
		).all<{ account_id: string; n: number; first: string; last: string }>();
		const { results: items } = await env.DB.prepare(
			"SELECT item_id, status, historical_complete, last_synced_at FROM bank_items",
		).all<{ item_id: string; status: string; historical_complete: number; last_synced_at: string | null }>();

		const lines = accounts.map((a) => {
			const h = history.find((row) => row.account_id === a.account_id);
			const item = items.find((row) => row.item_id === a.item_id);
			// For cards and loans Plaid's current balance is the amount owed.
			const isCredit = a.type === "credit" || a.type === "loan";
			const balance =
				a.balance_current === null
					? "balance unknown"
					: isCredit
						? `owed ${money(a.balance_current)}` +
							(a.balance_limit !== null ? `, limit ${money(a.balance_limit)}` : "") +
							(a.balance_available !== null ? `, available credit ${money(a.balance_available)}` : "")
						: `balance ${money(a.balance_current)}` +
							(a.balance_available !== null ? `, available ${money(a.balance_available)}` : "");
			const asOf = a.balance_as_of ? ` (as of ${a.balance_as_of.slice(0, 10)})` : "";
			const connection =
				item?.status === "login_required"
					? "needs sign-in (ask to reconnect)"
					: item?.status === "pending_disconnect"
						? "connection expiring soon (ask to reconnect)"
						: item?.historical_complete
							? "connected"
							: "connected, still importing history";
			const range = h ? `${h.n} transactions ${h.first} to ${h.last}` : "no transactions yet";
			return `${accountLabel(a)} | ${a.subtype ?? a.type} | ${balance}${asOf} | ${range} | ${connection}`;
		});
		return speak(["account | type | balance | history | connection", ...lines].join("\n"));
	},
});
