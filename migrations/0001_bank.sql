-- Bank feed (Plaid). See docs/PROJECT_CONTEXT.md ("Bank integration") and PLAID_PLAN.md.

-- One row per bank login ("Item"). The access token is AES-GCM encrypted with a key
-- derived from the JARVIS_SECRET_KEY Worker secret, and is '' once the Item is revoked.
CREATE TABLE bank_items (
	item_id TEXT PRIMARY KEY,
	access_token_enc TEXT NOT NULL,
	institution_id TEXT,
	institution_name TEXT,
	-- ok | login_required | pending_disconnect | revoked
	status TEXT NOT NULL DEFAULT 'ok',
	-- Committed /transactions/sync cursor; NULL until the first complete sync.
	sync_cursor TEXT,
	historical_complete INTEGER NOT NULL DEFAULT 0,
	last_synced_at TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

	-- Paged sync: each Queue message fetches one /transactions/sync page into the
	-- staging tables; when has_more is false one D1 batch applies the staged changes
	-- and the cursor. A message only runs if its run id and step match, so duplicate
	-- Queue deliveries are harmless.
	sync_run_id TEXT,
	sync_step INTEGER NOT NULL DEFAULT 0,
	-- The committed cursor this run started from (restart point after a mutation error).
	sync_start_cursor TEXT,
	-- The cursor the next page is fetched with.
	sync_next_cursor TEXT,
	sync_started_at TEXT,
	-- A sync was requested while one was running; start another after this one commits.
	sync_again INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE bank_accounts (
	account_id TEXT PRIMARY KEY,
	item_id TEXT NOT NULL REFERENCES bank_items(item_id) ON DELETE CASCADE,
	persistent_account_id TEXT,
	name TEXT NOT NULL,
	official_name TEXT,
	mask TEXT,
	type TEXT NOT NULL,
	subtype TEXT
);

CREATE TABLE bank_transactions (
	transaction_id TEXT PRIMARY KEY,
	item_id TEXT NOT NULL REFERENCES bank_items(item_id) ON DELETE CASCADE,
	account_id TEXT NOT NULL,
	-- Plaid's sign: positive = money out (a purchase), negative = money in (refund, payment received).
	amount REAL NOT NULL,
	currency TEXT,
	date TEXT NOT NULL,
	authorized_date TEXT,
	name TEXT,
	merchant_name TEXT,
	pending INTEGER NOT NULL,
	pending_transaction_id TEXT,
	category_primary TEXT,
	category_detailed TEXT,
	category_confidence TEXT,
	payment_channel TEXT
);

CREATE INDEX bank_transactions_date ON bank_transactions(date);
CREATE INDEX bank_transactions_item ON bank_transactions(item_id);

-- Pages of the in-progress sync run, invisible to queries until committed.
CREATE TABLE bank_sync_staged (
	item_id TEXT NOT NULL,
	transaction_id TEXT NOT NULL,
	account_id TEXT NOT NULL,
	amount REAL NOT NULL,
	currency TEXT,
	date TEXT NOT NULL,
	authorized_date TEXT,
	name TEXT,
	merchant_name TEXT,
	pending INTEGER NOT NULL,
	pending_transaction_id TEXT,
	category_primary TEXT,
	category_detailed TEXT,
	category_confidence TEXT,
	payment_channel TEXT,
	PRIMARY KEY (item_id, transaction_id)
);

CREATE TABLE bank_sync_removed (
	item_id TEXT NOT NULL,
	transaction_id TEXT NOT NULL,
	PRIMARY KEY (item_id, transaction_id)
);

-- Hosted Link sessions started by jarvis_connect_bank. Kept so a missed completion
-- webhook can be recovered with /link/token/get. item_id is set for update mode.
CREATE TABLE bank_link_sessions (
	link_token_hash TEXT PRIMARY KEY,
	link_token_enc TEXT NOT NULL,
	item_id TEXT,
	-- pending | completed | expired
	status TEXT NOT NULL DEFAULT 'pending',
	-- Safe to log; what Plaid support needs to investigate a Link session.
	link_session_id TEXT,
	expires_at TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
