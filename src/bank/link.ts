import {
	exchangePublicToken,
	getAccounts,
	getInstitution,
	getItem as getPlaidItem,
	getLinkToken,
	isTransientPlaidFailure,
	removeItem,
	type PlaidAccount,
} from "../lib/plaid";
import { escapeTelegramHtml, sendTelegramMessage } from "../lib/telegram";
import { enqueue, RetryLater } from "./jobs";
import {
	accessTokenFor,
	decryptLinkToken,
	encryptAccessToken,
	getItem,
	itemDisplayName,
	setItemStatus,
	type LinkSessionRow,
} from "./store";

/**
 * Finishes a Hosted Link session: on SESSION_FINISHED (or the hourly fallback),
 * read the session's results from /link/token/get, exchange each public token
 * at once (GUIDE-013), store the Item, and start its first sync (TXN-003).
 * Update-mode sessions confirm the repair with /item/get (ITEM-010).
 *
 * Safe to run more than once: re-exchanging returns the same Item (GUIDE-015)
 * and inserts are idempotent.
 */

type LinkEnv = Pick<
	Env,
	"DB" | "BANK_JOBS" | "JARVIS_SECRET_KEY" | "PLAID_CLIENT_ID" | "PLAID_SECRET" | "PLAID_ENV" | "TELEGRAM_BOT_TOKEN" | "TELEGRAM_CHAT_ID"
>;

async function notify(env: LinkEnv, html: string): Promise<void> {
	const sent = await sendTelegramMessage(env, html);
	if (!sent.ok) console.error(`Bank notification not delivered (${sent.reason}).`);
}

async function setSessionStatus(
	db: D1Database,
	hash: string,
	status: LinkSessionRow["status"],
	linkSessionId: string | null,
): Promise<void> {
	await db
		.prepare(
			"UPDATE bank_link_sessions SET status = ?, link_session_id = COALESCE(?, link_session_id) WHERE link_token_hash = ?",
		)
		.bind(status, linkSessionId, hash)
		.run();
}

export async function completeLink(env: LinkEnv, linkTokenHash: string, now = new Date()): Promise<void> {
	const session = await env.DB.prepare("SELECT * FROM bank_link_sessions WHERE link_token_hash = ?")
		.bind(linkTokenHash)
		.first<LinkSessionRow>();
	if (!session || session.status !== "pending") return;
	const expired = Date.parse(session.expires_at) <= now.getTime();

	const linkToken = await decryptLinkToken(env, session.link_token_enc);
	if (!linkToken) {
		await setSessionStatus(env.DB, linkTokenHash, "expired", null);
		return;
	}

	const result = await getLinkToken(env, linkToken);
	if (!result.ok) {
		if (isTransientPlaidFailure(result)) throw new RetryLater("Plaid /link/token/get unavailable.");
		// Session data is kept only ~6 hours after the session ends; past that it's gone.
		if (expired) await setSessionStatus(env.DB, linkTokenHash, "expired", null);
		return;
	}

	const finished = (result.data.link_sessions ?? []).filter((s) => s.finished_at);
	const linkSessionId = finished[finished.length - 1]?.link_session_id ?? null;
	if (linkSessionId) console.log(`Hosted Link session finished: link_session_id=${linkSessionId}`);
	if (finished.length === 0) {
		if (expired) await setSessionStatus(env.DB, linkTokenHash, "expired", null);
		return; // still open; the webhook or the next hourly check will come back
	}

	if (session.item_id) {
		await completeUpdateMode(env, session.item_id);
	} else {
		const added = finished.flatMap((s) => s.results?.item_add_results ?? []);
		for (const result of added) {
			await addItem(env, result.public_token, result.institution?.institution_id ?? null);
		}
	}
	await setSessionStatus(env.DB, linkTokenHash, "completed", linkSessionId);
}

async function completeUpdateMode(env: LinkEnv, itemId: string): Promise<void> {
	const item = await getItem(env.DB, itemId);
	if (!item || item.status === "revoked") return;
	const accessToken = await accessTokenFor(env, item);
	if (!accessToken) return;

	const live = await getPlaidItem(env, accessToken);
	if (!live.ok) {
		if (isTransientPlaidFailure(live)) throw new RetryLater("Plaid /item/get unavailable.");
		return;
	}
	if (live.data.item.error) return; // the user exited without fixing it; the reminder stays

	const previous = await setItemStatus(env.DB, itemId, "ok");
	const accounts = await getAccounts(env, accessToken);
	if (accounts.ok) await env.DB.batch(accountStatements(env.DB, itemId, accounts.data.accounts));
	await enqueue(env, { kind: "sync_start", itemId });
	if (previous !== "ok") {
		await notify(env, `<b>Bank connection</b>\n\n${escapeTelegramHtml(itemDisplayName(item))} is reconnected. Catching up on transactions now.`);
	}
}

async function addItem(env: LinkEnv, publicToken: string, hintedInstitutionId: string | null): Promise<void> {
	const exchanged = await exchangePublicToken(env, publicToken);
	if (!exchanged.ok) {
		if (isTransientPlaidFailure(exchanged)) throw new RetryLater("Plaid token exchange unavailable.");
		console.error("Public token exchange failed; this bank wasn't added.");
		return;
	}
	const { access_token: accessToken, item_id: itemId } = exchanged.data;

	const accounts = await getAccounts(env, accessToken);
	if (!accounts.ok && isTransientPlaidFailure(accounts)) throw new RetryLater("Plaid /accounts/get unavailable.");
	const institutionId = (accounts.ok ? accounts.data.item.institution_id : null) ?? hintedInstitutionId;

	// Duplicate guard (ITEM-001/011): a second live Item at the same bank is billed separately
	// and uses a Free Trial connection, so remove the new one and keep the existing one.
	if (institutionId) {
		const existing = await env.DB.prepare(
			"SELECT item_id, institution_name FROM bank_items WHERE institution_id = ? AND item_id != ? AND status != 'revoked'",
		)
			.bind(institutionId, itemId)
			.first<{ item_id: string; institution_name: string | null }>();
		if (existing) {
			const removed = await removeItem(env, accessToken);
			if (!removed.ok) console.error("Couldn't remove a duplicate bank connection; remove it in the Plaid Dashboard.");
			await notify(
				env,
				`<b>Bank connection</b>\n\n${escapeTelegramHtml(itemDisplayName(existing))} was already connected, so I removed the duplicate. ` +
					"If it needs fixing, ask Jarvis to reconnect it instead.",
			);
			return;
		}
	}

	// Display name from /institutions/get_by_id, not Link metadata (GUIDE-017).
	let institutionName: string | null = null;
	if (institutionId) {
		const institution = await getInstitution(env, institutionId);
		if (institution.ok) institutionName = institution.data.institution.name;
	}

	const [inserted] = await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO bank_items (item_id, access_token_enc, institution_id, institution_name)
			VALUES (?, ?, ?, ?) ON CONFLICT(item_id) DO NOTHING`,
		).bind(itemId, await encryptAccessToken(env, accessToken), institutionId, institutionName),
		...(accounts.ok ? accountStatements(env.DB, itemId, accounts.data.accounts) : []),
	]);
	// Always (re)start the sync: a retried job may have stored the Item but failed before this.
	await enqueue(env, { kind: "sync_start", itemId });
	if (!inserted?.meta.changes) return; // already announced on an earlier attempt

	const accountList = accounts.ok ? describeAccounts(accounts.data.accounts) : "";
	await notify(
		env,
		`<b>Bank connected</b>\n\n${escapeTelegramHtml(institutionName ?? "Your bank")} is connected${accountList}. ` +
			"Importing up to two years of transactions; I'll message you when it's done.",
	);
}

function describeAccounts(accounts: PlaidAccount[]): string {
	if (accounts.length === 0) return "";
	const names = accounts.map((a) => (a.mask ? `${a.name} ending ${a.mask}` : a.name));
	return ` (${escapeTelegramHtml(names.join(", "))})`;
}

function accountStatements(db: D1Database, itemId: string, accounts: PlaidAccount[]): D1PreparedStatement[] {
	return accounts.map((a) =>
		db.prepare(
			`INSERT OR REPLACE INTO bank_accounts
				(account_id, item_id, persistent_account_id, name, official_name, mask, type, subtype)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(
			a.account_id,
			itemId,
			a.persistent_account_id ?? null,
			a.name,
			a.official_name ?? null,
			a.mask ?? null,
			a.type,
			a.subtype ?? null,
		),
	);
}
