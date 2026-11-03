# Plaid plan: bank transactions in Jarvis

## Goal

"I want to build a PFM app using the Plaid Build Kit … pull my full transaction history, up to 2 years,
then keep it updated with /transactions/sync … give me a basic page that shows spending by category and
month." Built as a feature of Jarvis (this repo) rather than a separate local app, at the owner's request.
(workflow_id: wf_628a303ad81dcc1b)

## Scope

- Products: **transactions** only, in Link `products` (SELECT-001, CONV-001). Covers PNC checking
  (depository) and the Barclays US Frontier card (credit); nothing else in `products` so credit cards are
  not excluded (TXN-021). `transactions.days_requested: 730` at first Link, since it can't be raised
  later (TXN-009).
- Rejected: liabilities/investments in `additional_consented_products` (SELECT-005). Owner chose
  transactions only (2026-11-01); adding Liabilities later means one update-mode re-consent (CONV-011).
  Recurring Transactions (TXN-016) is the add-later candidate for subscriptions; it is enabled in
  production but not used.
- Balance product: not used (no refresh-now feature; BAL-001).
- Platform: Cloudflare Workers + TypeScript (plain `fetch` to the Plaid API; the Node SDK uses axios).
  Link surface: **Hosted Link** (no frontend to host, Plaid hosts the bank OAuth step; OAUTH-007).
- Geography: US only. Users: the owner only (`client_user_id` = Jarvis's Google `sub`).
- Environment: sandbox until acceptance passes; production via `PLAID_ENV` (GUIDE-004).

## Human tasks

| Task | Why it matters | Where | State |
|------|----------------|-------|-------|
| Put Sandbox keys in `.dev.vars` (`PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV=sandbox`) yourself | Local testing; keys must never be pasted into chat or written by the agent (GUIDE-021) | https://dashboard.plaid.com/developers/keys | verified (2026-11-01: Sandbox requests succeed) |
| Production secrets: `npx wrangler secret put PLAID_CLIENT_ID` / `PLAID_SECRET` (run in a real terminal; `!` gives no prompt) | Production calls | terminal | reported_done (2026-11-01; names confirmed, value proven at first connect) |
| Confirm company profile is complete and the latest Plaid MSA is accepted | PNC is silently absent from production Link without the latest MSA (OAUTH-008, TASK-006) | https://dashboard.plaid.com/settings/company/profile | cannot_verify |
| Data Transparency Messaging / Link customization "default" set up for production | INVALID_LINK_CUSTOMIZATION otherwise (PITFALL-002) | https://dashboard.plaid.com/link | cannot_verify |
| Production access + Transactions in US production | Required for real banks | dashboard_get_state products | verified (2026-11-01: production authorized; transactions in US production) |
| Redirect URI | Not needed: Hosted Link hosts the OAuth redirect (verified 2026-11-01 with Platypus OAuth Bank in Sandbox) | https://dashboard.plaid.com/developers/api | not_applicable |
| Dashboard webhooks | Item/product webhooks are set per Link token (`webhook` field), not in the Dashboard (TASK-003) | — | not_applicable |
| Sign in to PNC and Barclays in Hosted Link | Only the owner can enter bank credentials | Telegram link from `jarvis_connect_bank` | needs_human |
| Free Trial: 10 connections | Each re-link of the same bank uses a connection; the connect tool refuses duplicates (ITEM-001/011) | — | noted |

## Implementation checklist

- [x] D1 schema (`migrations/0001_bank.sql`): items (encrypted access token, cursor), accounts,
      transactions, link sessions, paged-sync staging
- [x] `src/lib/plaid.ts`: typed fetch client, timeout, never throws, logs only request_id (GUIDE-006, DATA-006)
- [x] `src/lib/secret-box.ts`: AES-GCM token encryption + signed page tokens (DATA-001)
- [x] `jarvis_connect_bank`: Hosted Link session → Telegram; update mode for broken logins (ITEM-003); refuses duplicates
- [x] `POST /plaid/webhook`: ES256 JWT + body hash verification (WEBHOOK-003/004), enqueue, 200 fast (WEBHOOK-001)
- [x] Queue consumer: complete Link sessions via /link/token/get, exchange (GUIDE-013/015), paged sync (TXN-002/004/007/011)
- [x] Item webhooks: ERROR / PENDING_DISCONNECT / LOGIN_REPAIRED / USER_PERMISSION_REVOKED (WEBHOOK-006)
- [x] Cron: hourly link-session reconcile; daily catch-up sync (WEBHOOK-007)
- [x] `jarvis_spending` voice tool; `jarvis_spending_page` signed link → `/spending` page
- [x] Tests (Plaid mocked; 35 bank tests), docs
- [x] End-to-end Sandbox run: `npm run test:sandbox` (2 personas, duplicate, reconnect) and `npm run test:hosted-link` (owner completed Platypus OAuth Bank via the Telegram Hosted Link)
- [x] Production: D1 + Queue created, remote migrations, secrets, deployed (2026-11-01, version 6cbaf783)
- [x] Link PNC and Barclays (owner, 2026-11-02)
- [x] Round 3: include_original_description, richer fields, cached balances via /accounts/get after each sync,
      jarvis_transactions / jarvis_accounts, spending group_by, page drill-down; one-time re-sync (DATA_VERSION 2)

## Acceptance

- Round 1 (2026-11-01): FAIL, 12 passed/not_applicable, 3 failed, all pending human steps:
  - CHECK-008: no Sandbox end-to-end run yet (sandbox keys not in `.dev.vars`).
  - CHECK-009: needs_human tasks remain (keys, PNC MSA/profile, DTM, bank sign-in).
  - CHECK-015: goal example verified on synthetic data only; second persona
    (user_transactions_dynamic) pending Sandbox.
  - CHECK-007 not_applicable (Hosted Link hosts OAuth); to be confirmed with Platypus OAuth Bank in Sandbox.

- Round 2 (2026-11-01): Sandbox end to end passed (`test:sandbox` 6/6, `test:hosted-link` 1/1).
  Persona 1 user_transactions_dynamic @ First Platypus: 311 transactions, 15 categories, 17 pending;
  "Spending for November 2026: $1,603 total." Persona 2 user_good @ First Gingham CU: 16 transactions,
  9 categories. Remaining: CHECK-009 (production human tasks).

- Round 3 (2026-11-02): unit 176/176; Sandbox 6/6 with real detail (311/311 raw descriptions and
  subcategories, 97 with counterparties, 22 located, 7/7 accounts with balances).

## Maintenance

This integration is maintained with the Plaid MCP; this file is its durable
state. Agents working in this repository: consult build_guidance before
modifying any Plaid-touching code, and re-run build_check_acceptance before
reporting such a change as working. The acceptance above applies only to
the code as it was verified — later changes invalidate it.

## How to test

### Setup (once)

1. Add to `.dev.vars` (never paste keys into chat): `PLAID_CLIENT_ID`, `PLAID_SECRET` (Sandbox),
   `PLAID_ENV=sandbox`, and `JARVIS_SECRET_KEY` (run `openssl rand -base64 32`).
2. `npx wrangler d1 migrations apply jarvis --local`
3. `npm run dev`, then MCP Inspector → Streamable HTTP → `http://localhost:8787/mcp`, sign in.

### Connect a bank (Sandbox)

1. Call `jarvis_connect_bank` with `mode: "new"`. Expect a spoken confirmation and a Telegram link.
2. Open the link, pick First Platypus Bank, sign in with `user_transactions_dynamic` / any password
   (or `user_good` / `pass_good`). Repeat with Platypus OAuth Bank (ins_127287) to check OAuth in Hosted Link.
3. Locally Plaid can't reach the webhook, so run the hourly check:
   `curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+*+*+*+*"`.
   Expect a "Bank connected" Telegram message, then "Bank history imported" once the Queue jobs finish.

### Spending

1. `jarvis_spending` with no arguments → this month's total and top categories.
2. `jarvis_spending_page` → Telegram link; open it within 15 minutes → table and monthly bars.
   Reopening after 15 minutes says the link has expired.

### Reconnect

1. With a Sandbox Item, call `/sandbox/item/reset_login`, then trigger a sync (daily cron URL with
   `cron=30+11+*+*+*`). Expect a "needs you to sign in again" Telegram message.
2. `jarvis_connect_bank` with `mode: "reconnect"`, `bank: "Platypus"` → sign in again → run the hourly check →
   "reconnected" message.

## Decisions made

- 2026-11-01, owner: build inside Jarvis; store in D1; secrets in `.dev.vars` / `wrangler secret put` (not `.env`).
- 2026-11-01, owner: Hosted Link URL is delivered to Telegram by a voice tool (`jarvis_connect_bank`); never spoken.
- 2026-11-01, owner: spending page opened via a short-lived signed link sent to Telegram.
- 2026-11-01, owner: transactions only (no Liabilities consent).
- Agent (from guidance): routes `POST /plaid/webhook` (public, signature-verified) and `GET /spending`
  (page shell; data needs the signed token, carried in the URL fragment so it never reaches server logs).
- Agent (Workers free plan, 10 ms CPU per invocation): each Queue message fetches one sync page into a
  staging table; the staged changes and the cursor are applied in one atomic D1 batch only when
  has_more is false. Same guarantee as TXN-002 (nothing visible or cursor advanced mid-loop) without
  holding every page in one invocation's memory.
- Agent: personal_finance_category pinned to v2 (TXN-006); spending excludes transfers, loan/card
  payments and income so a PNC → Barclays card payment isn't counted twice.

- Agent (Sandbox finding): Plaid can report HISTORICAL_UPDATE_COMPLETE on a sync that returns no
  transactions yet, so "history imported" requires complete AND at least one stored transaction.
- Agent (Sandbox finding): a Hosted Link session counts as finished if it has finished_at, any
  item_add_results, or an exit record.

## Open questions

- None.
