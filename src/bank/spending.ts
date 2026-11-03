/**
 * Spending queries over the stored bank transactions.
 *
 * "Spending" = purchases minus refunds (Plaid's sign: positive = money out),
 * excluding money that only moves between accounts or isn't spending:
 * transfers, loan and credit-card payments, loan disbursements and income.
 * Excluding LOAN_PAYMENTS is what stops a PNC → Barclays card payment from
 * being counted on top of the card purchases it pays for.
 *
 * Categories are Plaid's personal_finance_category v2 primaries (TXN-006).
 * Low-confidence categories are shown as "Uncategorized" rather than guessed.
 */

export const NON_SPENDING_CATEGORIES = [
	"TRANSFER_IN",
	"TRANSFER_OUT",
	"LOAN_PAYMENTS",
	"LOAN_DISBURSEMENTS",
	"INCOME",
] as const;

/** PFC v2 spending primaries, plus our bucket for unknown or low-confidence ones. */
export const SPENDING_CATEGORIES = [
	"FOOD_AND_DRINK",
	"GENERAL_MERCHANDISE",
	"TRAVEL",
	"TRANSPORTATION",
	"ENTERTAINMENT",
	"RENT_AND_UTILITIES",
	"GENERAL_SERVICES",
	"PERSONAL_CARE",
	"MEDICAL",
	"HOME_IMPROVEMENT",
	"BANK_FEES",
	"GOVERNMENT_AND_NON_PROFIT",
	"OTHER",
	"UNCATEGORIZED",
] as const;

export type SpendingCategory = (typeof SPENDING_CATEGORIES)[number];

const LABELS: Partial<Record<string, string>> = {
	GENERAL_MERCHANDISE: "Shopping",
	GENERAL_SERVICES: "Services",
	GOVERNMENT_AND_NON_PROFIT: "Government and charity",
	RENT_AND_UTILITIES: "Rent and utilities",
	HOME_IMPROVEMENT: "Home improvement",
	BANK_FEES: "Bank fees",
	UNCATEGORIZED: "Uncategorized",
};

export function categoryLabel(category: string): string {
	const known = LABELS[category];
	if (known) return known;
	const words = category.toLowerCase().replaceAll("_", " ");
	return words.charAt(0).toUpperCase() + words.slice(1);
}

const CATEGORY_SQL = `CASE
	WHEN category_primary IS NULL OR category_confidence IN ('LOW', 'UNKNOWN') THEN 'UNCATEGORIZED'
	WHEN category_primary IN (${SPENDING_CATEGORIES.map((c) => `'${c}'`).join(", ")}) THEN category_primary
	ELSE 'OTHER' END`;

const SPENDING_FILTER = `(category_primary IS NULL OR category_primary NOT IN (${NON_SPENDING_CATEGORIES.map((c) => `'${c}'`).join(", ")}))
	AND (currency IS NULL OR currency = 'USD')`;

export interface SpendingCell {
	month: string; // YYYY-MM
	category: string;
	total: number;
	count: number;
}

/** First day of the month after `month` (YYYY-MM), as YYYY-MM-DD. */
export function monthEndExclusive(month: string): string {
	const [year, mon] = month.split("-").map(Number) as [number, number];
	return mon === 12 ? `${year + 1}-01-01` : `${year}-${String(mon + 1).padStart(2, "0")}-01`;
}

export function addMonths(month: string, delta: number): string {
	const [year, mon] = month.split("-").map(Number) as [number, number];
	const index = year * 12 + (mon - 1) + delta;
	return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/** Spending per (month, category) for months fromMonth..toMonth inclusive. */
export async function spendingByMonth(
	db: D1Database,
	fromMonth: string,
	toMonth: string,
): Promise<SpendingCell[]> {
	const { results } = await db
		.prepare(
			`SELECT substr(date, 1, 7) AS month, ${CATEGORY_SQL} AS category,
				ROUND(SUM(amount), 2) AS total, COUNT(*) AS count
			FROM bank_transactions
			WHERE date >= ? AND date < ? AND ${SPENDING_FILTER}
			GROUP BY month, category
			ORDER BY month, total DESC`,
		)
		.bind(`${fromMonth}-01`, monthEndExclusive(toMonth))
		.all<SpendingCell>();
	return results;
}

export type SpendingGroup = "subcategory" | "merchant" | "month";

export interface SpendingGroupRow {
	key: string;
	primary: string | null;
	total: number;
	count: number;
}

/** Spending for fromMonth..toMonth grouped by subcategory, merchant or month (optionally one category). */
export async function spendingGrouped(
	db: D1Database,
	fromMonth: string,
	toMonth: string,
	groupBy: SpendingGroup,
	category?: string,
): Promise<SpendingGroupRow[]> {
	const key =
		groupBy === "month"
			? "substr(date, 1, 7)"
			: groupBy === "merchant"
				? "COALESCE(merchant_name, name, 'Unknown')"
				: "COALESCE(category_detailed, 'UNCATEGORIZED')";
	const categoryFilter = category ? ` AND ${CATEGORY_SQL} = ?` : "";
	const { results } = await db
		.prepare(
			`SELECT ${key} AS key, MAX(category_primary) AS "primary", ROUND(SUM(amount), 2) AS total, COUNT(*) AS count
			FROM bank_transactions
			WHERE date >= ? AND date < ? AND ${SPENDING_FILTER}${categoryFilter}
			GROUP BY key ORDER BY ${groupBy === "month" ? "key" : "total DESC"}`,
		)
		.bind(`${fromMonth}-01`, monthEndExclusive(toMonth), ...(category ? [category] : []))
		.all<SpendingGroupRow>();
	return results;
}

export interface BankStatusSummary {
	connected: number;
	importing: string[];
	needsReconnect: string[];
	lastSyncedAt: string | null;
}

export async function bankStatus(db: D1Database): Promise<BankStatusSummary> {
	const { results } = await db
		.prepare(
			"SELECT institution_name, status, historical_complete, last_synced_at FROM bank_items WHERE status != 'revoked'",
		)
		.all<{ institution_name: string | null; status: string; historical_complete: number; last_synced_at: string | null }>();
	const name = (n: string | null) => n?.trim() || "your bank";
	return {
		connected: results.length,
		importing: results.filter((r) => !r.historical_complete).map((r) => name(r.institution_name)),
		needsReconnect: results.filter((r) => r.status === "login_required").map((r) => name(r.institution_name)),
		lastSyncedAt: results.reduce<string | null>(
			(latest, r) => (r.last_synced_at && (!latest || r.last_synced_at > latest) ? r.last_synced_at : latest),
			null,
		),
	};
}

/** "$1,234" (whole dollars read better aloud; cents only under $10). */
export function speakDollars(amount: number): string {
	const abs = Math.abs(amount);
	const text = abs < 10 ? abs.toFixed(2) : Math.round(abs).toLocaleString("en-US");
	return `${amount < 0 ? "minus " : ""}$${text}`;
}

const MONTH_NAMES = [
	"January", "February", "March", "April", "May", "June",
	"July", "August", "September", "October", "November", "December",
];

export function monthName(month: string): string {
	const [year, mon] = month.split("-").map(Number) as [number, number];
	return `${MONTH_NAMES[mon - 1]} ${year}`;
}
