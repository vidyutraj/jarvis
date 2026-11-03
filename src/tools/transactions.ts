import { z } from "zod";
import { SPENDING_CATEGORIES } from "../bank/spending";
import { bankStatus } from "../bank/spending";
import { accountLabel, listAccounts, matchAccounts, money, searchTransactions, transactionLine } from "../bank/transactions";
import { speak } from "../lib/respond";
import { dateContext } from "./calendar-common";
import { defineTool } from "./types";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CATEGORIES = [...SPENDING_CATEGORIES, "INCOME", "TRANSFER_IN", "TRANSFER_OUT", "LOAN_PAYMENTS", "LOAN_DISBURSEMENTS"] as const;

export const transactionsTool = defineTool({
	name: "jarvis_transactions",
	description: (context) =>
		"Look up the user's individual bank and credit card transactions (imported automatically from their connected banks), " +
		"with full detail: date and time, merchant, amount, category and subcategory, account, online or in store, location, " +
		"payment app or marketplace, pending status and the bank's raw description. Use for questions about specific purchases " +
		"or patterns, e.g. 'what did I buy at Amazon last week', 'my last 10 card charges', 'anything over $100 this month', " +
		"'did my paycheck come in', 'how often do I go to Starbucks'. Combine filters freely. For totals by category, merchant " +
		"or month use jarvis_spending instead. Results are one transaction per line: date | merchant | out/in amount | " +
		"category > subcategory | account | details. Summarise them for the user in speech; never read the list verbatim. " +
		`${dateContext(context)}`,
	inputSchema: z.object({
		from_date: z.string().regex(DATE).optional().describe("Earliest date, YYYY-MM-DD."),
		to_date: z.string().regex(DATE).optional().describe("Latest date, YYYY-MM-DD, inclusive."),
		text: z
			.string()
			.trim()
			.max(60)
			.optional()
			.describe("Merchant or description words to match, e.g. 'amazon', 'starbucks', 'venmo', 'frontier'."),
		category: z
			.enum(CATEGORIES)
			.optional()
			.describe("A category, e.g. FOOD_AND_DRINK, TRAVEL, INCOME (paychecks), LOAN_PAYMENTS (card payments)."),
		account: z
			.string()
			.trim()
			.max(40)
			.optional()
			.describe("Which account, as the user said it: bank name ('PNC', 'Barclays'), 'checking', 'credit card' or last four digits."),
		min_amount: z.number().nonnegative().optional().describe("Minimum amount in dollars (either direction)."),
		max_amount: z.number().nonnegative().optional().describe("Maximum amount in dollars (either direction)."),
		direction: z
			.enum(["out", "in", "any"])
			.optional()
			.describe("'out' = purchases and payments made, 'in' = money received (refunds, deposits). Default any."),
		spending_only: z
			.boolean()
			.optional()
			.describe("True to leave out transfers, card payments and income, i.e. only real spending."),
		sort: z.enum(["newest", "oldest", "largest"]).optional().describe("Default newest."),
		limit: z.number().int().min(1).max(50).optional().describe("How many to list (default 20, max 50)."),
	}),
	annotations: { readOnlyHint: true },
	handler: async (args, { env }) => {
		const status = await bankStatus(env.DB);
		if (status.connected === 0) {
			return speak("No bank accounts are connected yet. Ask me to connect your bank to get started.");
		}

		let accountIds: string[] | undefined;
		let accountNote = "";
		if (args.account) {
			const matched = matchAccounts(await listAccounts(env.DB), args.account);
			if (matched.length === 0) return speak(`I couldn't find an account matching "${args.account}".`);
			accountIds = matched.map((a) => a.account_id);
			accountNote = `, account ${matched.map(accountLabel).join(" or ")}`;
		}

		const result = await searchTransactions(env.DB, {
			fromDate: args.from_date,
			toDate: args.to_date,
			text: args.text,
			category: args.category,
			accountIds,
			minAmount: args.min_amount,
			maxAmount: args.max_amount,
			direction: args.direction,
			spendingOnly: args.spending_only,
			sort: args.sort,
			limit: args.limit ?? 20,
		});

		const filters = [
			args.from_date || args.to_date ? `${args.from_date ?? "start"} to ${args.to_date ?? "today"}` : null,
			args.text ? `matching "${args.text}"` : null,
			args.category ? `category ${args.category}` : null,
			args.min_amount !== undefined ? `at least ${money(args.min_amount)}` : null,
			args.max_amount !== undefined ? `at most ${money(args.max_amount)}` : null,
			args.direction && args.direction !== "any" ? `money ${args.direction}` : null,
			args.spending_only ? "spending only" : null,
		]
			.filter(Boolean)
			.join(", ");

		if (result.count === 0) {
			return speak(`No transactions found${filters ? ` (${filters}${accountNote})` : ""}.`);
		}
		const shown = result.rows.length;
		const header =
			`${result.count} transaction${result.count === 1 ? "" : "s"}${filters || accountNote ? ` (${filters}${accountNote})` : ""}` +
			` from ${result.firstDate} to ${result.lastDate}: ${money(result.totalOut)} out, ${money(result.totalIn)} in.` +
			(shown < result.count ? ` Showing ${shown}, ${args.sort ?? "newest"} first.` : "");
		const caveat =
			status.importing.length > 0 ? "\nNote: history is still importing, so older transactions may be missing." : "";
		return speak(
			[header + caveat, "date | merchant | amount | category | account | details", ...result.rows.map(transactionLine)].join("\n"),
		);
	},
});
