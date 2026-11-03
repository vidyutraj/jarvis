import { categoryLabel, NON_SPENDING_CATEGORIES } from "./spending";
import { normalizeBankName } from "./store";

/**
 * Transaction and account queries shared by the voice tools and the spending page.
 * Output is structured for Claude to reason over: one record per line, fixed field
 * order, money direction spelled out ("out"/"in") instead of Plaid's sign.
 */

export interface AccountRow {
	account_id: string;
	item_id: string;
	name: string;
	official_name: string | null;
	mask: string | null;
	type: string;
	subtype: string | null;
	institution_name: string | null;
	item_status: string;
	balance_current: number | null;
	balance_available: number | null;
	balance_limit: number | null;
	balance_currency: string | null;
	balance_as_of: string | null;
}

export async function listAccounts(db: D1Database): Promise<AccountRow[]> {
	const { results } = await db
		.prepare(
			`SELECT a.*, i.institution_name, i.status AS item_status FROM bank_accounts a
			JOIN bank_items i ON i.item_id = a.item_id
			WHERE i.status != 'revoked' ORDER BY i.created_at, a.name`,
		)
		.all<AccountRow>();
	return results;
}

/** "PNC Checking ••1234". */
export function accountLabel(a: Pick<AccountRow, "institution_name" | "name" | "mask">): string {
	const bank = a.institution_name?.split(/\s+-\s+/)[0]?.trim();
	const parts = [bank && !a.name.toLowerCase().includes(bank.toLowerCase()) ? bank : null, a.name].filter(Boolean);
	return `${parts.join(" ")}${a.mask ? ` ••${a.mask}` : ""}`;
}

/** Accounts matching spoken words: bank name, account name, last four digits, or type ("credit card"). */
export function matchAccounts(accounts: AccountRow[], spoken: string): AccountRow[] {
	const wanted = normalizeBankName(spoken);
	if (!wanted) return [];
	const haystack = (a: AccountRow) =>
		[a.institution_name, a.name, a.official_name, a.mask, a.type, a.subtype, a.subtype === "credit card" ? "card" : null]
			.filter(Boolean)
			.map((v) => normalizeBankName(String(v)));
	return accounts.filter((a) => haystack(a).some((h) => h.includes(wanted) || (h.length >= 3 && wanted.includes(h))));
}

/** "Coffee" from FOOD_AND_DRINK_COFFEE under FOOD_AND_DRINK. */
export function subcategoryLabel(primary: string | null, detailed: string | null): string | null {
	if (!detailed) return null;
	const rest = primary && detailed.startsWith(`${primary}_`) ? detailed.slice(primary.length + 1) : detailed;
	return categoryLabel(rest);
}

export function money(amount: number): string {
	return `$${Math.abs(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Plaid sign → words: positive is money leaving the account. */
export function flow(amount: number): string {
	return `${amount >= 0 ? "out" : "in"} ${money(amount)}`;
}

export interface TransactionFilters {
	fromDate?: string;
	toDate?: string;
	text?: string;
	category?: string;
	accountIds?: string[];
	minAmount?: number;
	maxAmount?: number;
	direction?: "out" | "in" | "any";
	/** Only real spending (excludes transfers, card payments, income). */
	spendingOnly?: boolean;
	includePending?: boolean;
	sort?: "newest" | "oldest" | "largest";
	limit?: number;
	offset?: number;
}

export interface TransactionRow {
	transaction_id: string;
	account_id: string;
	amount: number;
	currency: string | null;
	date: string;
	datetime: string | null;
	authorized_date: string | null;
	name: string | null;
	merchant_name: string | null;
	original_description: string | null;
	pending: number;
	category_primary: string | null;
	category_detailed: string | null;
	category_confidence: string | null;
	payment_channel: string | null;
	website: string | null;
	location_city: string | null;
	location_region: string | null;
	location_address: string | null;
	counterparties: string | null;
	check_number: string | null;
	account_name: string | null;
	account_mask: string | null;
	institution_name: string | null;
}

export interface TransactionSearch {
	rows: TransactionRow[];
	count: number;
	totalOut: number;
	totalIn: number;
	firstDate: string | null;
	lastDate: string | null;
}

function escapeLike(text: string): string {
	return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export async function searchTransactions(db: D1Database, f: TransactionFilters): Promise<TransactionSearch> {
	const where: string[] = [];
	const params: (string | number)[] = [];
	if (f.fromDate) {
		where.push("t.date >= ?");
		params.push(f.fromDate);
	}
	if (f.toDate) {
		where.push("t.date <= ?");
		params.push(f.toDate);
	}
	if (f.text?.trim()) {
		const like = `%${escapeLike(f.text.trim())}%`;
		const fields = ["t.merchant_name", "t.name", "t.original_description", "t.counterparties", "t.website"];
		where.push(fields.map((field) => `${field} LIKE ? ESCAPE '\\'`).join(" OR "));
		params.push(...fields.map(() => like));
	}
	if (f.category) {
		if (f.category === "UNCATEGORIZED") {
			where.push("(t.category_primary IS NULL OR t.category_confidence IN ('LOW', 'UNKNOWN'))");
		} else {
			where.push("(t.category_primary = ? OR t.category_detailed = ?)");
			params.push(f.category, f.category);
			// Spending totals file low-confidence categories under Uncategorized; match them.
			if (f.spendingOnly) where.push("t.category_confidence IS NULL OR t.category_confidence NOT IN ('LOW', 'UNKNOWN')");
		}
	}
	if (f.accountIds) {
		if (f.accountIds.length === 0) where.push("0");
		else {
			where.push(`t.account_id IN (${f.accountIds.map(() => "?").join(", ")})`);
			params.push(...f.accountIds);
		}
	}
	if (f.minAmount !== undefined) {
		where.push("ABS(t.amount) >= ?");
		params.push(f.minAmount);
	}
	if (f.maxAmount !== undefined) {
		where.push("ABS(t.amount) <= ?");
		params.push(f.maxAmount);
	}
	if (f.direction === "out") where.push("t.amount > 0");
	if (f.direction === "in") where.push("t.amount < 0");
	if (f.spendingOnly) {
		where.push(
			`(t.category_primary IS NULL OR t.category_primary NOT IN (${NON_SPENDING_CATEGORIES.map((c) => `'${c}'`).join(", ")}))`,
		);
	}
	if (f.includePending === false) where.push("t.pending = 0");
	// History of revoked banks stays searchable, so there's no status filter here.
	const clause = where.length > 0 ? `WHERE ${where.map((w) => `(${w})`).join(" AND ")}` : "";
	const from = `FROM bank_transactions t JOIN bank_items i ON i.item_id = t.item_id
		LEFT JOIN bank_accounts a ON a.account_id = t.account_id`;
	const order =
		f.sort === "largest"
			? "ABS(t.amount) DESC, t.date DESC"
			: f.sort === "oldest"
				? "t.date ASC, COALESCE(t.datetime, '') ASC"
				: "t.date DESC, COALESCE(t.datetime, '') DESC";
	const limit = Math.min(Math.max(f.limit ?? 20, 1), 200);
	const offset = Math.max(f.offset ?? 0, 0);

	const [rows, totals] = await db.batch([
		db
			.prepare(
				`SELECT t.transaction_id, t.account_id, t.amount, t.currency, t.date, t.datetime, t.authorized_date, t.name,
					t.merchant_name, t.original_description, t.pending, t.category_primary, t.category_detailed,
					t.category_confidence, t.payment_channel, t.website, t.location_city, t.location_region,
					t.location_address, t.counterparties, t.check_number,
					a.name AS account_name, a.mask AS account_mask, i.institution_name
				${from} ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`,
			)
			.bind(...params, limit, offset),
		db
			.prepare(
				`SELECT COUNT(*) AS count, COALESCE(SUM(CASE WHEN t.amount > 0 THEN t.amount END), 0) AS total_out,
					COALESCE(-SUM(CASE WHEN t.amount < 0 THEN t.amount END), 0) AS total_in,
					MIN(t.date) AS first_date, MAX(t.date) AS last_date
				${from} ${clause}`,
			)
			.bind(...params),
	]);
	const t = (totals!.results[0] ?? {}) as { count?: number; total_out?: number; total_in?: number; first_date?: string; last_date?: string };
	return {
		rows: rows!.results as unknown as TransactionRow[],
		count: t.count ?? 0,
		totalOut: Math.round((t.total_out ?? 0) * 100) / 100,
		totalIn: Math.round((t.total_in ?? 0) * 100) / 100,
		firstDate: t.first_date ?? null,
		lastDate: t.last_date ?? null,
	};
}

/** Display fields for one transaction, used by both the tool text and the page JSON. */
export function describeTransaction(t: TransactionRow) {
	const sub = subcategoryLabel(t.category_primary, t.category_detailed);
	const lowConfidence = !t.category_primary || t.category_confidence === "LOW" || t.category_confidence === "UNKNOWN";
	const counterparties = t.counterparties ? (JSON.parse(t.counterparties) as { name: string; type: string | null }[]) : [];
	const place = [t.location_city, t.location_region].filter(Boolean).join(", ");
	return {
		id: t.transaction_id,
		date: t.date,
		time: t.datetime ? t.datetime.slice(11, 16) : null,
		merchant: t.merchant_name ?? t.name ?? t.original_description ?? "Unknown",
		description: t.original_description ?? t.name ?? null,
		amount: t.amount,
		direction: t.amount >= 0 ? "out" : "in",
		currency: t.currency ?? "USD",
		category: t.category_primary ? categoryLabel(t.category_primary) : "Uncategorized",
		subcategory: sub,
		categoryUncertain: lowConfidence,
		account: accountLabel({ institution_name: t.institution_name, name: t.account_name ?? "Account", mask: t.account_mask }),
		channel: t.payment_channel,
		pending: t.pending === 1,
		place: place || null,
		website: t.website,
		via: counterparties.filter((c) => c.type === "marketplace" || c.type === "payment_app").map((c) => c.name),
		checkNumber: t.check_number,
	};
}

/** One structured line per transaction (fields separated by " | "). */
export function transactionLine(t: TransactionRow): string {
	const d = describeTransaction(t);
	const category = [d.category, d.subcategory].filter(Boolean).join(" > ") + (d.categoryUncertain ? " (uncertain)" : "");
	const extras = [
		d.pending ? "pending" : null,
		d.channel,
		d.place ? `at ${d.place}` : null,
		d.via.length ? `via ${d.via.join(", ")}` : null,
		d.checkNumber ? `check ${d.checkNumber}` : null,
		d.description && d.description.toLowerCase() !== d.merchant.toLowerCase() ? `bank text "${d.description}"` : null,
	].filter(Boolean);
	return [d.date + (d.time ? ` ${d.time}` : ""), d.merchant, flow(d.amount), category, d.account, extras.join("; ")].join(" | ");
}
