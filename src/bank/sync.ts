import {
	getAccounts,
	isTransientPlaidFailure,
	RECONNECT_ERROR_CODES,
	syncTransactions,
	type PlaidTransaction,
} from "../lib/plaid";
import { markNeedsReconnect, notifyHistoryImported, revokeAndNotify } from "./item-events";
import { enqueue, RetryLater } from "./jobs";
import { accessTokenFor, accountUpsert, getItem } from "./store";

/**
 * Paged /transactions/sync (TXN-002/004/007). One Queue message = one page:
 * the page is written to staging tables, and only when has_more is false are
 * the staged changes and the new cursor applied in one atomic D1 batch. Queries
 * never see a partial update, and the committed cursor never advances mid-loop.
 *
 * Every write is fenced on (run id, step), so a duplicate or stale Queue
 * delivery can't touch a newer run's data.
 */

/** A run that hasn't advanced in this long is considered dead and may be replaced. */
export const STALE_RUN_MS = 30 * 60 * 1000;

// D1 allows 100 bound parameters per statement.
const MAX_PARAMS = 100;
const STAGED_COLUMNS = [
	"item_id",
	"transaction_id",
	"account_id",
	"amount",
	"currency",
	"date",
	"authorized_date",
	"name",
	"merchant_name",
	"pending",
	"pending_transaction_id",
	"category_primary",
	"category_detailed",
	"category_confidence",
	"payment_channel",
	"original_description",
	"datetime",
	"authorized_datetime",
	"merchant_entity_id",
	"website",
	"logo_url",
	"location_address",
	"location_city",
	"location_region",
	"location_postal_code",
	"location_country",
	"location_lat",
	"location_lon",
	"store_number",
	"counterparties",
	"transaction_code",
	"check_number",
] as const;
const GUARD_PARAMS = 3;
const GUARD = "EXISTS (SELECT 1 FROM bank_items WHERE item_id = ? AND sync_run_id = ? AND sync_step = ?)";
const SYNCABLE_STATUSES = "('ok', 'pending_disconnect')";

type SyncEnv = Pick<
	Env,
	"DB" | "BANK_JOBS" | "JARVIS_SECRET_KEY" | "PLAID_CLIENT_ID" | "PLAID_SECRET" | "PLAID_ENV" | "TELEGRAM_BOT_TOKEN" | "TELEGRAM_CHAT_ID"
>;

/** Starts a sync run, or flags the running one to go again once it commits. */
export async function startSync(env: SyncEnv, itemId: string, now = new Date()): Promise<void> {
	const runId = crypto.randomUUID();
	const staleBefore = new Date(now.getTime() - STALE_RUN_MS).toISOString();
	const acquired = await env.DB.prepare(
		`UPDATE bank_items SET sync_run_id = ?1, sync_step = 0, sync_start_cursor = sync_cursor,
			sync_next_cursor = sync_cursor, sync_started_at = ?2, sync_again = 0
		WHERE item_id = ?3 AND status IN ${SYNCABLE_STATUSES}
			AND (sync_run_id IS NULL OR sync_started_at < ?4)`,
	)
		.bind(runId, now.toISOString(), itemId, staleBefore)
		.run();

	if (acquired.meta.changes === 0) {
		await env.DB.prepare(
			`UPDATE bank_items SET sync_again = 1 WHERE item_id = ? AND sync_run_id IS NOT NULL AND status IN ${SYNCABLE_STATUSES}`,
		)
			.bind(itemId)
			.run();
		return;
	}

	// Leftovers from a dead run must not leak into this one.
	await env.DB.batch(clearStaging(env.DB, itemId));
	try {
		await enqueue(env, { kind: "sync_page", itemId, runId, step: 0 });
	} catch {
		await endRun(env.DB, itemId, runId);
		throw new RetryLater("Couldn't enqueue the first sync page.");
	}
}

export async function syncPage(
	env: SyncEnv,
	itemId: string,
	runId: string,
	step: number,
	now = new Date(),
): Promise<void> {
	const item = await getItem(env.DB, itemId);
	if (!item || item.sync_run_id !== runId || item.sync_step !== step) return; // stale or duplicate

	const accessToken = await accessTokenFor(env, item);
	if (!accessToken) {
		console.error(`Bank sync: no usable access token for item ${itemId}; ending run.`);
		await endRun(env.DB, itemId, runId);
		return;
	}

	const result = await syncTransactions(env, accessToken, item.sync_next_cursor);
	const guard = [itemId, runId, step] as const;

	if (!result.ok) {
		if (result.reason === "api_error") {
			if (result.errorCode === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION") {
				// Restart the whole loop from the cursor the run started with (TXN-007).
				await env.DB.batch([
					...clearStaging(env.DB, itemId, guard),
					env.DB.prepare(
						`UPDATE bank_items SET sync_next_cursor = sync_start_cursor, sync_step = sync_step + 1
						WHERE item_id = ? AND sync_run_id = ? AND sync_step = ?`,
					).bind(...guard),
				]);
				await enqueue(env, { kind: "sync_page", itemId, runId, step: step + 1 });
				return;
			}
			if (RECONNECT_ERROR_CODES.has(result.errorCode)) {
				await endRun(env.DB, itemId, runId);
				await markNeedsReconnect(env, itemId, "login_required");
				return;
			}
			if (result.errorCode === "ITEM_NOT_FOUND") {
				await endRun(env.DB, itemId, runId);
				await revokeAndNotify(env, itemId);
				return;
			}
		}
		if (isTransientPlaidFailure(result)) {
			throw new RetryLater(`Transient Plaid failure during sync of item ${itemId}.`);
		}
		// Not retryable here (e.g. PRODUCT_NOT_READY: the readiness webhook will start a new run).
		await endRun(env.DB, itemId, runId);
		return;
	}

	const page = result.data;
	const statements = stagePage(env.DB, itemId, guard, [...page.added, ...page.modified], page.removed);

	if (page.has_more) {
		statements.push(
			env.DB.prepare(
				`UPDATE bank_items SET sync_next_cursor = ?, sync_step = sync_step + 1
				WHERE item_id = ? AND sync_run_id = ? AND sync_step = ?`,
			).bind(page.next_cursor, ...guard),
		);
		await env.DB.batch(statements);
		await enqueue(env, { kind: "sync_page", itemId, runId, step: step + 1 });
		return;
	}

	const historicalNow = page.transactions_update_status === "HISTORICAL_UPDATE_COMPLETE" ? 1 : 0;
	const columns = STAGED_COLUMNS.join(", ");
	statements.push(
		env.DB.prepare(
			`INSERT OR REPLACE INTO bank_transactions (${columns})
			SELECT ${columns} FROM bank_sync_staged WHERE item_id = ? AND ${GUARD}`,
		).bind(itemId, ...guard),
		env.DB.prepare(
			`DELETE FROM bank_transactions WHERE transaction_id IN
				(SELECT transaction_id FROM bank_sync_removed WHERE item_id = ?) AND ${GUARD}`,
		).bind(itemId, ...guard),
		...clearStaging(env.DB, itemId, guard),
		env.DB.prepare(
			`UPDATE bank_items SET sync_cursor = ?, sync_run_id = NULL, sync_start_cursor = NULL,
				sync_next_cursor = NULL, sync_started_at = NULL, last_synced_at = ?,
				historical_complete = MAX(historical_complete, CASE WHEN ? = 1
					AND EXISTS (SELECT 1 FROM bank_transactions WHERE item_id = ?) THEN 1 ELSE 0 END)
			WHERE item_id = ? AND sync_run_id = ? AND sync_step = ?
			RETURNING sync_again, historical_complete`,
		).bind(page.next_cursor, now.toISOString(), historicalNow, itemId, ...guard),
	);
	const results = await env.DB.batch<{ sync_again: number; historical_complete: number }>(statements);
	const committed = results[results.length - 1]?.results[0];
	if (!committed) return; // lost the run to a newer one; nothing was applied

	// Cached balances ride along with Transactions at no extra cost (/accounts/get, not
	// the billed real-time /accounts/balance/get). Best effort: a failure keeps old values.
	await refreshAccounts(env, itemId, accessToken, now);

	// "Complete" only counts once transactions are actually stored: Plaid can report
	// HISTORICAL_UPDATE_COMPLETE on a sync that returns nothing yet (seen in Sandbox).
	if (committed.historical_complete && !item.historical_complete) {
		await notifyHistoryImported(env, itemId);
	}
	if (committed.sync_again) {
		await enqueue(env, { kind: "sync_start", itemId });
	}
}

/** Upserts the Item's accounts with Plaid's cached balances. Never throws. */
export async function refreshAccounts(env: SyncEnv, itemId: string, accessToken: string, now = new Date()): Promise<void> {
	const result = await getAccounts(env, accessToken);
	if (!result.ok) return;
	await env.DB.batch(result.data.accounts.map((a) => accountUpsert(env.DB, itemId, a, now)));
}

/** Releases a run's lock and drops its staged pages. */
export async function endRun(db: D1Database, itemId: string, runId: string): Promise<void> {
	await db.batch([
		...clearStaging(db, itemId),
		db.prepare(
			`UPDATE bank_items SET sync_run_id = NULL, sync_start_cursor = NULL, sync_next_cursor = NULL,
				sync_started_at = NULL WHERE item_id = ? AND sync_run_id = ?`,
		).bind(itemId, runId),
	]);
}

function clearStaging(
	db: D1Database,
	itemId: string,
	guard?: readonly [string, string, number],
): D1PreparedStatement[] {
	const fence = guard ? ` AND ${GUARD}` : "";
	const params = guard ? [itemId, ...guard] : [itemId];
	return [
		db.prepare(`DELETE FROM bank_sync_staged WHERE item_id = ?${fence}`).bind(...params),
		db.prepare(`DELETE FROM bank_sync_removed WHERE item_id = ?${fence}`).bind(...params),
	];
}

function stagedRow(itemId: string, tx: PlaidTransaction): (string | number | null)[] {
	const category = tx.personal_finance_category;
	return [
		itemId,
		tx.transaction_id,
		tx.account_id,
		tx.amount,
		tx.iso_currency_code ?? tx.unofficial_currency_code ?? null,
		tx.date,
		tx.authorized_date ?? null,
		tx.name ?? null,
		tx.merchant_name ?? null,
		tx.pending ? 1 : 0,
		tx.pending_transaction_id ?? null,
		category?.primary ?? null,
		category?.detailed ?? null,
		category?.confidence_level ?? null,
		tx.payment_channel ?? null,
		tx.original_description ?? null,
		tx.datetime ?? null,
		tx.authorized_datetime ?? null,
		tx.merchant_entity_id ?? null,
		tx.website ?? null,
		tx.logo_url ?? null,
		tx.location?.address ?? null,
		tx.location?.city ?? null,
		tx.location?.region ?? null,
		tx.location?.postal_code ?? null,
		tx.location?.country ?? null,
		tx.location?.lat ?? null,
		tx.location?.lon ?? null,
		tx.location?.store_number ?? null,
		counterpartiesJson(tx),
		tx.transaction_code ?? null,
		tx.check_number ?? null,
	];
}

function counterpartiesJson(tx: PlaidTransaction): string | null {
	const list = (tx.counterparties ?? [])
		.filter((c) => c?.name)
		.map((c) => ({ name: c.name, type: c.type ?? null, website: c.website ?? null, confidence: c.confidence_level ?? null }));
	return list.length > 0 ? JSON.stringify(list) : null;
}

function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

/**
 * Applies one page to staging in Plaid's order: added/modified upsert, removed
 * delete (and override any staged copy). A later page's add un-removes an id.
 */
function stagePage(
	db: D1Database,
	itemId: string,
	guard: readonly [string, string, number],
	upserts: PlaidTransaction[],
	removed: { transaction_id: string }[],
): D1PreparedStatement[] {
	const statements: D1PreparedStatement[] = [];
	const columns = STAGED_COLUMNS.join(", ");
	const rowPlaceholder = `(${STAGED_COLUMNS.map(() => "?").join(", ")})`;
	const rowsPerStatement = Math.floor((MAX_PARAMS - GUARD_PARAMS) / STAGED_COLUMNS.length);

	const upsertIds = upserts.map((tx) => tx.transaction_id);
	for (const ids of chunk(upsertIds, MAX_PARAMS - 1 - GUARD_PARAMS)) {
		statements.push(
			db.prepare(
				`DELETE FROM bank_sync_removed WHERE item_id = ? AND transaction_id IN (${ids.map(() => "?").join(", ")}) AND ${GUARD}`,
			).bind(itemId, ...ids, ...guard),
		);
	}
	for (const rows of chunk(upserts, rowsPerStatement)) {
		statements.push(
			db.prepare(
				`INSERT OR REPLACE INTO bank_sync_staged (${columns})
				SELECT * FROM (VALUES ${rows.map(() => rowPlaceholder).join(", ")}) WHERE ${GUARD}`,
			).bind(...rows.flatMap((tx) => stagedRow(itemId, tx)), ...guard),
		);
	}

	const removedIds = removed.map((r) => r.transaction_id);
	for (const ids of chunk(removedIds, MAX_PARAMS - 1 - GUARD_PARAMS)) {
		statements.push(
			db.prepare(
				`DELETE FROM bank_sync_staged WHERE item_id = ? AND transaction_id IN (${ids.map(() => "?").join(", ")}) AND ${GUARD}`,
			).bind(itemId, ...ids, ...guard),
		);
	}
	for (const ids of chunk(removedIds, Math.floor((MAX_PARAMS - GUARD_PARAMS) / 2))) {
		statements.push(
			db.prepare(
				`INSERT OR IGNORE INTO bank_sync_removed (item_id, transaction_id)
				SELECT * FROM (VALUES ${ids.map(() => "(?, ?)").join(", ")}) WHERE ${GUARD}`,
			).bind(...ids.flatMap((id) => [itemId, id]), ...guard),
		);
	}
	return statements;
}
