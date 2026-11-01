import { decryptSecret, encryptSecret } from "../lib/secret-box";

/** D1 access for the bank feed. Tokens are encrypted before they reach D1. */

export type ItemStatus = "ok" | "login_required" | "pending_disconnect" | "revoked";

export interface BankItemRow {
	item_id: string;
	access_token_enc: string;
	institution_id: string | null;
	institution_name: string | null;
	status: ItemStatus;
	sync_cursor: string | null;
	historical_complete: number;
	last_synced_at: string | null;
	sync_run_id: string | null;
	sync_step: number;
	sync_start_cursor: string | null;
	sync_next_cursor: string | null;
	sync_started_at: string | null;
	sync_again: number;
}

export interface LinkSessionRow {
	link_token_hash: string;
	link_token_enc: string;
	item_id: string | null;
	status: "pending" | "completed" | "expired";
	link_session_id: string | null;
	expires_at: string;
}

type SecretEnv = Pick<Env, "JARVIS_SECRET_KEY">;

export function getItem(db: D1Database, itemId: string): Promise<BankItemRow | null> {
	return db.prepare("SELECT * FROM bank_items WHERE item_id = ?").bind(itemId).first<BankItemRow>();
}

export async function listItems(db: D1Database): Promise<BankItemRow[]> {
	const { results } = await db.prepare("SELECT * FROM bank_items ORDER BY created_at").all<BankItemRow>();
	return results;
}

export function encryptAccessToken(env: SecretEnv, accessToken: string): Promise<string> {
	return encryptSecret(env.JARVIS_SECRET_KEY, "plaid-access-token", accessToken);
}

/** Null if the Item was revoked (token purged) or the stored value can't be decrypted. */
export async function accessTokenFor(env: SecretEnv, item: BankItemRow): Promise<string | null> {
	if (!item.access_token_enc) return null;
	return decryptSecret(env.JARVIS_SECRET_KEY, "plaid-access-token", item.access_token_enc);
}

export function encryptLinkToken(env: SecretEnv, linkToken: string): Promise<string> {
	return encryptSecret(env.JARVIS_SECRET_KEY, "plaid-link-token", linkToken);
}

export function decryptLinkToken(env: SecretEnv, sealed: string): Promise<string | null> {
	return decryptSecret(env.JARVIS_SECRET_KEY, "plaid-link-token", sealed);
}

/** Sets the status; returns the previous one so callers notify only on a change. */
export async function setItemStatus(
	db: D1Database,
	itemId: string,
	status: ItemStatus,
): Promise<ItemStatus | null> {
	const before = await db
		.prepare("SELECT status FROM bank_items WHERE item_id = ?")
		.bind(itemId)
		.first<{ status: ItemStatus }>();
	if (!before) return null;
	await db.prepare("UPDATE bank_items SET status = ? WHERE item_id = ?").bind(status, itemId).run();
	return before.status;
}

/** Revoked Items keep their transactions but lose the token, so nothing can call Plaid for them. */
export async function revokeItem(db: D1Database, itemId: string): Promise<ItemStatus | null> {
	const previous = await setItemStatus(db, itemId, "revoked");
	await db
		.prepare("UPDATE bank_items SET access_token_enc = '', sync_run_id = NULL WHERE item_id = ?")
		.bind(itemId)
		.run();
	return previous;
}

export function itemDisplayName(item: Pick<BankItemRow, "institution_name">): string {
	return item.institution_name?.trim() || "your bank";
}

/** Normalizes spoken bank names: "P.N.C." → "pnc", "Barclays US" → "barclaysus". */
export function normalizeBankName(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Items whose institution name matches a spoken name (exact, then partial). */
export function matchItemsByName(items: BankItemRow[], spoken: string): BankItemRow[] {
	const wanted = normalizeBankName(spoken);
	if (!wanted) return [];
	const exact = items.filter((item) => normalizeBankName(item.institution_name ?? "") === wanted);
	if (exact.length > 0) return exact;
	return items.filter((item) => {
		const name = normalizeBankName(item.institution_name ?? "");
		return name.length > 0 && (name.includes(wanted) || wanted.includes(name));
	});
}
