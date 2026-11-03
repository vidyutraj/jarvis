-- Richer transaction detail (raw bank text, time, location, merchant, counterparties)
-- and cached account balances from /accounts/get. See PLAID_PLAN.md, round 3.

ALTER TABLE bank_transactions ADD COLUMN original_description TEXT;
ALTER TABLE bank_transactions ADD COLUMN datetime TEXT;
ALTER TABLE bank_transactions ADD COLUMN authorized_datetime TEXT;
ALTER TABLE bank_transactions ADD COLUMN merchant_entity_id TEXT;
ALTER TABLE bank_transactions ADD COLUMN website TEXT;
ALTER TABLE bank_transactions ADD COLUMN logo_url TEXT;
ALTER TABLE bank_transactions ADD COLUMN location_address TEXT;
ALTER TABLE bank_transactions ADD COLUMN location_city TEXT;
ALTER TABLE bank_transactions ADD COLUMN location_region TEXT;
ALTER TABLE bank_transactions ADD COLUMN location_postal_code TEXT;
ALTER TABLE bank_transactions ADD COLUMN location_country TEXT;
ALTER TABLE bank_transactions ADD COLUMN location_lat REAL;
ALTER TABLE bank_transactions ADD COLUMN location_lon REAL;
ALTER TABLE bank_transactions ADD COLUMN store_number TEXT;
-- JSON array of {name, type, website, confidence}.
ALTER TABLE bank_transactions ADD COLUMN counterparties TEXT;
ALTER TABLE bank_transactions ADD COLUMN transaction_code TEXT;
ALTER TABLE bank_transactions ADD COLUMN check_number TEXT;

ALTER TABLE bank_sync_staged ADD COLUMN original_description TEXT;
ALTER TABLE bank_sync_staged ADD COLUMN datetime TEXT;
ALTER TABLE bank_sync_staged ADD COLUMN authorized_datetime TEXT;
ALTER TABLE bank_sync_staged ADD COLUMN merchant_entity_id TEXT;
ALTER TABLE bank_sync_staged ADD COLUMN website TEXT;
ALTER TABLE bank_sync_staged ADD COLUMN logo_url TEXT;
ALTER TABLE bank_sync_staged ADD COLUMN location_address TEXT;
ALTER TABLE bank_sync_staged ADD COLUMN location_city TEXT;
ALTER TABLE bank_sync_staged ADD COLUMN location_region TEXT;
ALTER TABLE bank_sync_staged ADD COLUMN location_postal_code TEXT;
ALTER TABLE bank_sync_staged ADD COLUMN location_country TEXT;
ALTER TABLE bank_sync_staged ADD COLUMN location_lat REAL;
ALTER TABLE bank_sync_staged ADD COLUMN location_lon REAL;
ALTER TABLE bank_sync_staged ADD COLUMN store_number TEXT;
ALTER TABLE bank_sync_staged ADD COLUMN counterparties TEXT;
ALTER TABLE bank_sync_staged ADD COLUMN transaction_code TEXT;
ALTER TABLE bank_sync_staged ADD COLUMN check_number TEXT;

CREATE INDEX bank_transactions_merchant ON bank_transactions(merchant_name);
CREATE INDEX bank_transactions_account ON bank_transactions(account_id, date);

-- Cached balances (free with Transactions via /accounts/get; not real-time).
ALTER TABLE bank_accounts ADD COLUMN balance_current REAL;
ALTER TABLE bank_accounts ADD COLUMN balance_available REAL;
ALTER TABLE bank_accounts ADD COLUMN balance_limit REAL;
ALTER TABLE bank_accounts ADD COLUMN balance_currency TEXT;
ALTER TABLE bank_accounts ADD COLUMN balance_as_of TEXT;

-- Bumped when stored fields change; the hourly cron re-syncs older Items once from
-- an empty cursor so existing history gains the new fields (no new bank login).
ALTER TABLE bank_items ADD COLUMN data_version INTEGER NOT NULL DEFAULT 1;
