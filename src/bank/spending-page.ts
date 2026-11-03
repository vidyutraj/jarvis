import { todayIn } from "../lib/dates";
import { verifyPageToken } from "../lib/secret-box";
import { addMonths, bankStatus, categoryLabel, monthEndExclusive, SPENDING_CATEGORIES, spendingByMonth } from "./spending";
import { describeTransaction, searchTransactions } from "./transactions";

/**
 * The spending page: a static shell at /spending plus /spending/app.js, which
 * reads a signed token from the URL fragment (never sent to the server, so it
 * can't land in request logs), clears it from the address bar, and POSTs it to
 * the data endpoints. Only a valid, unexpired token returns any data.
 */

export const SPENDING_PATH = "/spending";
const SCRIPT_PATH = "/spending/app.js";
const DATA_PATH = "/spending/data";
const TRANSACTIONS_PATH = "/spending/transactions";
const MONTHS_SHOWN = 24;
const PAGE_SIZE = 50;

const SECURITY_HEADERS = {
	"Content-Security-Policy":
		"default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
	"X-Frame-Options": "DENY",
	"Referrer-Policy": "no-referrer",
	"Cache-Control": "no-store",
};

const HTML = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Jarvis spending</title>
<style>
	:root { color-scheme: light dark; font-family: system-ui, sans-serif; --bar: #1a73e8; --muted: color-mix(in srgb, currentColor 55%, transparent); --line: color-mix(in srgb, currentColor 15%, transparent); --in: #188038; }
	body { max-width: 72rem; margin: 2rem auto; padding: 0 16px; line-height: 1.4; }
	h1 { font-size: 1.4rem; margin-bottom: .25rem; }
	h2 { font-size: 1.1rem; margin: 2rem 0 .5rem; }
	.muted, #status { color: var(--muted); margin-top: 0; }
	.bars { display: grid; gap: 4px; margin: 1.5rem 0; }
	.bar { display: grid; grid-template-columns: 5.5rem 1fr 6rem; align-items: center; gap: .5rem; font-variant-numeric: tabular-nums; }
	.bar span:last-child { text-align: right; }
	.fill { height: .9rem; background: var(--bar); border-radius: 2px; min-width: 1px; }
	.scroll { overflow-x: auto; }
	table { border-collapse: collapse; font-variant-numeric: tabular-nums; font-size: .9rem; }
	th, td { padding: .35rem .6rem; border-bottom: 1px solid var(--line); text-align: right; white-space: nowrap; }
	th:first-child, td:first-child { text-align: left; position: sticky; left: 0; background: Canvas; }
	tfoot td { font-weight: 600; }
	td button { font: inherit; background: none; border: 0; padding: 0; color: inherit; cursor: pointer; text-decoration: underline dotted; }
	form { display: flex; gap: .5rem; flex-wrap: wrap; margin: .5rem 0; }
	input, form button { font: inherit; padding: .4rem .6rem; border-radius: .4rem; border: 1px solid var(--line); }
	#tx td { text-align: left; white-space: normal; }
	#tx td.amt { text-align: right; white-space: nowrap; }
	.in { color: var(--in); }
	.sub { color: var(--muted); font-size: .85em; }
</style>
<body>
<h1>Spending by category and month</h1>
<p id="status">Loading…</p>
<div class="bars" id="bars"></div>
<p class="muted">Click any amount to see its transactions.</p>
<div class="scroll"><table id="table"></table></div>
<h2 id="tx-title">Recent transactions</h2>
<form id="search"><input id="q" type="search" placeholder="Search merchant or bank text" maxlength="60" aria-label="Search transactions"><button>Search</button></form>
<p id="tx-summary" class="muted"></p>
<div class="scroll"><table id="tx"></table></div>
<p><button id="more" hidden>Show more</button></p>
<script src="${SCRIPT_PATH}"></script>
</body>
</html>`;

// Plain DOM with textContent only: nothing from the data is ever parsed as HTML.
const SCRIPT = `(() => {
	const token = location.hash.slice(1);
	history.replaceState(null, "", location.pathname);
	const $ = (id) => document.getElementById(id);
	const status = $("status");
	const money = (n, cents) => Math.abs(n).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: cents ? 2 : 0, minimumFractionDigits: cents ? 2 : 0 });
	const el = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined && text !== null) e.textContent = text; if (cls) e.className = cls; return e; };
	const post = (path, body) => fetch(path, { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(body || {}) })
		.then((r) => r.ok ? r.json() : Promise.reject(r.status));
	const fail = (code) => { status.textContent = code === 401 ? "This link has expired. Ask Jarvis to send your spending page again." : "Couldn't load your spending. Try again in a moment."; };
	if (!token) { status.textContent = "This page needs a fresh link from Jarvis. Ask Jarvis to send your spending page."; return; }

	let query = {}; let offset = 0;
	function loadTransactions(q, title, append) {
		query = q; offset = append ? offset : 0;
		if (!append) { $("tx").replaceChildren(); $("tx-title").textContent = title; }
		post("${TRANSACTIONS_PATH}", Object.assign({ offset }, q)).then((d) => {
			$("tx-summary").textContent = d.count + " transactions, " + money(d.totalOut, true) + " out, " + money(d.totalIn, true) + " in.";
			const table = $("tx");
			if (!append) { const hr = el("tr"); for (const h of ["Date", "Merchant", "Amount", "Category", "Account", "Details"]) hr.appendChild(el("th", h)); const head = el("thead"); head.appendChild(hr); table.appendChild(head); table.appendChild(el("tbody")); }
			const body = table.tBodies[0];
			for (const t of d.transactions) {
				const tr = el("tr");
				tr.appendChild(el("td", t.date + (t.time ? " " + t.time : "")));
				const m = el("td", t.merchant); if (t.description && t.description.toLowerCase() !== t.merchant.toLowerCase()) { m.appendChild(el("br")); m.appendChild(el("span", t.description, "sub")); } tr.appendChild(m);
				tr.appendChild(el("td", (t.direction === "in" ? "+" : "") + money(t.amount, true), "amt" + (t.direction === "in" ? " in" : "")));
				tr.appendChild(el("td", t.category + (t.subcategory ? " › " + t.subcategory : "") + (t.categoryUncertain ? " (?)" : "")));
				tr.appendChild(el("td", t.account));
				tr.appendChild(el("td", [t.pending ? "pending" : null, t.channel, t.place, t.via.length ? "via " + t.via.join(", ") : null].filter(Boolean).join(" · ")));
				body.appendChild(tr);
			}
			offset += d.transactions.length;
			$("more").hidden = offset >= d.count;
		}).catch(fail);
	}
	$("more").addEventListener("click", () => loadTransactions(query, null, true));
	$("search").addEventListener("submit", (e) => { e.preventDefault(); const text = $("q").value.trim(); loadTransactions(text ? { text } : {}, text ? "Transactions matching “" + text + "”" : "Recent transactions"); });

	post("${DATA_PATH}").then((d) => {
		status.textContent = d.note;
		const months = d.months.filter((m) => d.totals[m] !== undefined || d.months.indexOf(m) >= d.months.length - 12);
		const max = Math.max(1, ...months.map((m) => d.totals[m] || 0));
		const bars = $("bars");
		for (const m of months) {
			const row = el("div", null, "bar");
			const fill = el("div", null, "fill"); fill.style.width = (100 * Math.max(0, d.totals[m] || 0) / max) + "%";
			const track = el("div"); track.appendChild(fill);
			row.append(el("span", m), track, el("span", money(d.totals[m] || 0)));
			bars.appendChild(row);
		}
		const table = $("table");
		const head = el("thead"); const hr = el("tr"); hr.appendChild(el("th", "Category"));
		for (const m of months) hr.appendChild(el("th", m));
		head.appendChild(hr); table.appendChild(head);
		const body = el("tbody");
		for (const c of d.categories) {
			const tr = el("tr"); tr.appendChild(el("td", c.label));
			for (const m of months) {
				const td = el("td");
				if (c.byMonth[m]) {
					const b = el("button", money(c.byMonth[m]));
					b.addEventListener("click", () => { loadTransactions({ month: m, category: c.key }, c.label + " in " + m); $("tx-title").scrollIntoView({ behavior: "smooth" }); });
					td.appendChild(b);
				}
				tr.appendChild(td);
			}
			body.appendChild(tr);
		}
		table.appendChild(body);
		const foot = el("tfoot"); const fr = el("tr"); fr.appendChild(el("td", "Total"));
		for (const m of months) fr.appendChild(el("td", money(d.totals[m] || 0)));
		foot.appendChild(fr); table.appendChild(foot);
		loadTransactions({}, "Recent transactions");
	}).catch(fail);
})();`;

type PageEnv = Pick<Env, "DB" | "JARVIS_SECRET_KEY" | "TIME_ZONE">;

async function authorized(request: Request, env: PageEnv): Promise<boolean> {
	const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
	return verifyPageToken(env.JARVIS_SECRET_KEY, token);
}

/** Handles /spending and its script and data endpoints; null for any other path. */
export async function handleSpendingRoute(request: Request, env: PageEnv): Promise<Response | null> {
	const { pathname } = new URL(request.url);
	if (pathname === SPENDING_PATH && request.method === "GET") {
		return new Response(HTML, { headers: { ...SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8" } });
	}
	if (pathname === SCRIPT_PATH && request.method === "GET") {
		return new Response(SCRIPT, {
			headers: { ...SECURITY_HEADERS, "Content-Type": "text/javascript; charset=utf-8" },
		});
	}
	if ((pathname === DATA_PATH || pathname === TRANSACTIONS_PATH) && request.method === "POST") {
		if (!(await authorized(request, env))) {
			return new Response("Unauthorized", { status: 401, headers: SECURITY_HEADERS });
		}
		if (pathname === DATA_PATH) return Response.json(await spendingData(env), { headers: SECURITY_HEADERS });
		const query = await readTransactionQuery(request);
		if (!query) return new Response("Bad request", { status: 400, headers: SECURITY_HEADERS });
		return Response.json(await transactionsData(env, query), { headers: SECURITY_HEADERS });
	}
	return null;
}

interface TransactionQuery {
	month?: string;
	category?: string;
	text?: string;
	offset: number;
}

/** Validates the page's JSON body; null for anything malformed. */
async function readTransactionQuery(request: Request): Promise<TransactionQuery | null> {
	let body: Record<string, unknown>;
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		return null;
	}
	const { month, category, text, offset } = body;
	if (month !== undefined && (typeof month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month))) return null;
	if (category !== undefined && !(SPENDING_CATEGORIES as readonly unknown[]).includes(category)) return null;
	if (text !== undefined && (typeof text !== "string" || text.length > 60)) return null;
	if (offset !== undefined && (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0 || offset > 100_000)) return null;
	return {
		...(month ? { month: month as string } : {}),
		...(category ? { category: category as string } : {}),
		...(text ? { text: text as string } : {}),
		offset: (offset as number | undefined) ?? 0,
	};
}

export async function transactionsData(env: PageEnv, q: TransactionQuery) {
	const lastDay = q.month ? new Date(Date.parse(`${monthEndExclusive(q.month)}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10) : undefined;
	const result = await searchTransactions(env.DB, {
		fromDate: q.month ? `${q.month}-01` : undefined,
		toDate: lastDay,
		category: q.category,
		text: q.text,
		// A category cell is spending, so match the table's definition.
		spendingOnly: q.category !== undefined,
		limit: PAGE_SIZE,
		offset: q.offset,
	});
	return {
		count: result.count,
		totalOut: result.totalOut,
		totalIn: result.totalIn,
		transactions: result.rows.map(describeTransaction),
	};
}

export async function spendingData(env: PageEnv, now = new Date()) {
	const toMonth = todayIn(env.TIME_ZONE, now).slice(0, 7);
	const fromMonth = addMonths(toMonth, -(MONTHS_SHOWN - 1));
	const [cells, status] = await Promise.all([spendingByMonth(env.DB, fromMonth, toMonth), bankStatus(env.DB)]);

	const months = Array.from({ length: MONTHS_SHOWN }, (_, i) => addMonths(fromMonth, i));
	const totals: Record<string, number> = {};
	const categories = new Map<string, { key: string; label: string; total: number; byMonth: Record<string, number> }>();
	for (const cell of cells) {
		totals[cell.month] = Math.round(((totals[cell.month] ?? 0) + cell.total) * 100) / 100;
		const entry = categories.get(cell.category) ?? { key: cell.category, label: categoryLabel(cell.category), total: 0, byMonth: {} };
		entry.total += cell.total;
		entry.byMonth[cell.month] = cell.total;
		categories.set(cell.category, entry);
	}

	const notes = [
		status.connected === 0 ? "No banks connected yet." : `${status.connected} bank connection(s).`,
		status.lastSyncedAt ? `Last updated ${status.lastSyncedAt.slice(0, 16).replace("T", " ")} UTC.` : "",
		status.importing.length ? `Still importing: ${status.importing.join(", ")}.` : "",
		status.needsReconnect.length ? `Needs reconnecting: ${status.needsReconnect.join(", ")}.` : "",
		"Excludes transfers, card payments and income; refunds are netted.",
	].filter(Boolean);

	return {
		note: notes.join(" "),
		months,
		totals,
		categories: [...categories.values()]
			.sort((a, b) => b.total - a.total)
			.map(({ key, label, byMonth }) => ({ key, label, byMonth })),
	};
}
