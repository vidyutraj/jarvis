import { todayIn } from "../lib/dates";
import { verifyPageToken } from "../lib/secret-box";
import { addMonths, bankStatus, categoryLabel, spendingByMonth } from "./spending";

/**
 * The spending page: a static shell at /spending plus /spending/app.js, which
 * reads a signed token from the URL fragment (never sent to the server, so it
 * can't land in request logs), clears it from the address bar, and POSTs it to
 * /spending/data. Only a valid, unexpired token returns any data.
 */

export const SPENDING_PATH = "/spending";
const SCRIPT_PATH = "/spending/app.js";
const DATA_PATH = "/spending/data";
const MONTHS_SHOWN = 24;

const SECURITY_HEADERS = {
	"Content-Security-Policy":
		"default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
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
	:root { color-scheme: light dark; font-family: system-ui, sans-serif; --bar: #1a73e8; --muted: color-mix(in srgb, currentColor 55%, transparent); --line: color-mix(in srgb, currentColor 15%, transparent); }
	body { max-width: 72rem; margin: 2rem auto; padding: 0 16px; line-height: 1.4; }
	h1 { font-size: 1.4rem; margin-bottom: .25rem; }
	#status { color: var(--muted); margin-top: 0; }
	.bars { display: grid; gap: 4px; margin: 1.5rem 0; }
	.bar { display: grid; grid-template-columns: 5.5rem 1fr 6rem; align-items: center; gap: .5rem; font-variant-numeric: tabular-nums; }
	.bar span:last-child { text-align: right; }
	.fill { height: .9rem; background: var(--bar); border-radius: 2px; min-width: 1px; }
	.scroll { overflow-x: auto; }
	table { border-collapse: collapse; font-variant-numeric: tabular-nums; font-size: .9rem; }
	th, td { padding: .35rem .6rem; border-bottom: 1px solid var(--line); text-align: right; white-space: nowrap; }
	th:first-child, td:first-child { text-align: left; position: sticky; left: 0; background: Canvas; }
	tfoot td { font-weight: 600; }
</style>
<body>
<h1>Spending by category and month</h1>
<p id="status">Loading…</p>
<div class="bars" id="bars"></div>
<div class="scroll"><table id="table"></table></div>
<script src="${SCRIPT_PATH}"></script>
</body>
</html>`;

// Plain DOM with textContent only: nothing from the data is ever parsed as HTML.
const SCRIPT = `(() => {
	const token = location.hash.slice(1);
	history.replaceState(null, "", location.pathname);
	const status = document.getElementById("status");
	const money = (n) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
	const el = (tag, text) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; return e; };
	if (!token) { status.textContent = "This page needs a fresh link from Jarvis. Ask Jarvis to send your spending page."; return; }
	fetch("${DATA_PATH}", { method: "POST", headers: { Authorization: "Bearer " + token } })
		.then((r) => r.ok ? r.json() : Promise.reject(r.status))
		.then((d) => {
			status.textContent = d.note;
			const months = d.months.filter((m) => d.totals[m] !== undefined || d.months.indexOf(m) >= d.months.length - 12);
			const max = Math.max(1, ...months.map((m) => d.totals[m] || 0));
			const bars = document.getElementById("bars");
			for (const m of months) {
				const row = el("div"); row.className = "bar";
				const fill = el("div"); fill.className = "fill"; fill.style.width = (100 * Math.max(0, d.totals[m] || 0) / max) + "%";
				const track = el("div"); track.appendChild(fill);
				row.append(el("span", m), track, el("span", money(d.totals[m] || 0)));
				bars.appendChild(row);
			}
			const table = document.getElementById("table");
			const head = el("thead"); const hr = el("tr"); hr.appendChild(el("th", "Category"));
			for (const m of months) hr.appendChild(el("th", m));
			head.appendChild(hr); table.appendChild(head);
			const body = el("tbody");
			for (const c of d.categories) {
				const tr = el("tr"); tr.appendChild(el("td", c.label));
				for (const m of months) tr.appendChild(el("td", c.byMonth[m] ? money(c.byMonth[m]) : ""));
				body.appendChild(tr);
			}
			table.appendChild(body);
			const foot = el("tfoot"); const fr = el("tr"); fr.appendChild(el("td", "Total"));
			for (const m of months) fr.appendChild(el("td", money(d.totals[m] || 0)));
			foot.appendChild(fr); table.appendChild(foot);
		})
		.catch((code) => {
			status.textContent = code === 401
				? "This link has expired. Ask Jarvis to send your spending page again."
				: "Couldn't load your spending. Try again in a moment.";
		});
})();`;

type PageEnv = Pick<Env, "DB" | "JARVIS_SECRET_KEY" | "TIME_ZONE">;

/** Handles /spending, /spending/app.js and /spending/data; null for any other path. */
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
	if (pathname === DATA_PATH && request.method === "POST") {
		const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
		if (!(await verifyPageToken(env.JARVIS_SECRET_KEY, token))) {
			return new Response("Unauthorized", { status: 401, headers: SECURITY_HEADERS });
		}
		return Response.json(await spendingData(env), { headers: SECURITY_HEADERS });
	}
	return null;
}

export async function spendingData(env: PageEnv, now = new Date()) {
	const toMonth = todayIn(env.TIME_ZONE, now).slice(0, 7);
	const fromMonth = addMonths(toMonth, -(MONTHS_SHOWN - 1));
	const [cells, status] = await Promise.all([spendingByMonth(env.DB, fromMonth, toMonth), bankStatus(env.DB)]);

	const months = Array.from({ length: MONTHS_SHOWN }, (_, i) => addMonths(fromMonth, i));
	const totals: Record<string, number> = {};
	const categories = new Map<string, { label: string; total: number; byMonth: Record<string, number> }>();
	for (const cell of cells) {
		totals[cell.month] = Math.round(((totals[cell.month] ?? 0) + cell.total) * 100) / 100;
		const entry = categories.get(cell.category) ?? { label: categoryLabel(cell.category), total: 0, byMonth: {} };
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
			.map(({ label, byMonth }) => ({ label, byMonth })),
	};
}
