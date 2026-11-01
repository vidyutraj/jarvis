import { z } from "zod";
import {
	addMonths,
	bankStatus,
	categoryLabel,
	monthName,
	SPENDING_CATEGORIES,
	spendingByMonth,
	speakDollars,
} from "../bank/spending";
import { todayIn } from "../lib/dates";
import { speak, speakError } from "../lib/respond";
import { dateContext } from "./calendar-common";
import { defineTool } from "./types";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const TOP_CATEGORIES = 5;

export const spendingTool = defineTool({
	name: "jarvis_spending",
	description: (context) =>
		"Answer questions about the user's spending from their connected bank and credit card transactions " +
		"(imported automatically from their banks). Use for questions like 'how much did I spend last month', " +
		"'what did I spend on food in October' or 'my biggest spending categories this year'. Spending excludes " +
		"transfers, card payments and income. Give months as YYYY-MM; for one month set both to the same month. " +
		`Defaults to the current month. ${dateContext(context)}`,
	inputSchema: z.object({
		from_month: z.string().regex(MONTH).optional().describe("First month, YYYY-MM. Defaults to this month."),
		to_month: z.string().regex(MONTH).optional().describe("Last month, YYYY-MM, inclusive. Defaults to from_month."),
		category: z
			.enum(SPENDING_CATEGORIES)
			.optional()
			.describe(
				"Only this category, e.g. FOOD_AND_DRINK (restaurants, groceries, coffee), GENERAL_MERCHANDISE " +
					"(shopping, Amazon), TRAVEL (flights, hotels), TRANSPORTATION (gas, rideshare, parking).",
			),
	}),
	annotations: { readOnlyHint: true },
	handler: async ({ from_month, to_month, category }, { env }) => {
		const status = await bankStatus(env.DB);
		if (status.connected === 0) {
			return speak("No bank accounts are connected yet. Ask me to connect your bank to get started.");
		}

		const thisMonth = todayIn(env.TIME_ZONE).slice(0, 7);
		let from = from_month ?? to_month ?? thisMonth;
		let to = to_month ?? from;
		if (to < from) [from, to] = [to, from];
		if (from < addMonths(to, -35)) return speakError("I can look at up to three years at a time.");

		const cells = await spendingByMonth(env.DB, from, to);
		const period = from === to ? monthName(from) : `${monthName(from)} to ${monthName(to)}`;
		const caveats = [
			status.importing.length > 0 ? "Your history is still importing, so this may be incomplete." : "",
			status.needsReconnect.length > 0
				? `${status.needsReconnect.join(" and ")} needs reconnecting, so recent purchases may be missing.`
				: "",
		].filter(Boolean);

		if (category) {
			const matching = cells.filter((cell) => cell.category === category);
			const total = matching.reduce((sum, cell) => sum + cell.total, 0);
			const count = matching.reduce((sum, cell) => sum + cell.count, 0);
			const line = `${categoryLabel(category)} in ${period}: ${speakDollars(total)} across ${count} transaction${count === 1 ? "" : "s"}.`;
			return speak([line, ...caveats].join(" "));
		}

		const byCategory = new Map<string, number>();
		for (const cell of cells) byCategory.set(cell.category, (byCategory.get(cell.category) ?? 0) + cell.total);
		const total = [...byCategory.values()].reduce((sum, value) => sum + value, 0);
		if (byCategory.size === 0) return speak([`No spending found for ${period}.`, ...caveats].join(" "));

		const ranked = [...byCategory.entries()].filter(([, amount]) => amount > 0).sort((a, b) => b[1] - a[1]);
		const top = ranked.slice(0, TOP_CATEGORIES).map(([name, amount]) => `${categoryLabel(name)} ${speakDollars(amount)}`);
		const rest = ranked.length - top.length;
		// Read tools may return a compact list for Claude to summarise.
		const lines = [
			`Spending for ${period}: ${speakDollars(total)} total.`,
			`Top categories: ${top.join(", ")}${rest > 0 ? `, plus ${rest} more` : ""}.`,
			...caveats,
		];
		return speak(lines.join("\n"));
	},
});
