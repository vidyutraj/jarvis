# Jarvis – Project Context

This file captures the decisions made while planning this project. It explains *why* things are set up the way they are. CLAUDE.md holds the day-to-day rules; this is the background.

## What this is

A personal voice assistant. I talk to it through the **Claude app's voice mode** (iPhone, Max plan). Claude is the brain. This repo is a **remote MCP server on Cloudflare Workers** that exposes my custom tools; it's added to Claude as a custom connector.

Goal: a seamless, live, chatty voice experience, like a normal Claude voice conversation, but with my own tools.

## Key constraints and preferences

- **Free wherever possible.** The only paid thing is the Claude API, and I have ~$200 in API credits. Conversations themselves run on my Max plan, so API credits are only for background jobs (e.g. scheduled reports).
- **Keep it lean.** I don't want an overbearing assistant. Prefer on-demand features over constant notifications.
- **Spoken output.** Every tool result is read aloud, so responses must be short and natural to say.
- **Never send email.** Gmail integration gets search, read and create_draft only. I review and send drafts myself.

## Architecture

- **Front end:** Claude app voice mode
- **Server:** Cloudflare Workers (free tier), scaffolded from `cloudflare/ai/demos/remote-mcp-authless`
- **Storage:** D1 (SQLite) for expenses, notes history, bank transactions; KV for OAuth tokens
- **Background work:** Cloudflare Queues (free plan) for bank syncing, one small job per invocation
- **Scheduled jobs:** Cloudflare Cron Triggers (weekly/monthly reports via the Claude API)
- **Notifications:** Telegram bot (free; chosen over SMS, which costs money)
- **Secrets:** `wrangler secret put` in production, `.dev.vars` locally (gitignored)

## Features and decisions

1. **Voice notes → Telegram.** I ramble, Claude tidies it into a note, it's sent to me on Telegram. For capturing ideas; no time attached.
2. **Calendar events.** Google Calendar API. I have multiple calendars (e.g. Work, Personal), so the tool takes a calendar name mapped to calendar IDs, with a default. Always give Claude the current date and my time zone so "next Thursday" resolves correctly.
3. **Reminders.** Must land in the **Apple Reminders app** on my iPhone (not Google Tasks). **Resolved:** the Claude iOS app's built-in Reminders access works fully, so no custom reminders tool is needed. (The iOS Shortcut fallback is no longer needed.) Reminders are for "do this at a specific time"; notes are for "remember this idea."
4. **Gmail drafts.** Flow: "What was the last email from X?" → Claude reads/summarises → I say my reply → saved as a draft in the same thread. Optional Telegram ping: "draft ready." Also useful for finding flight details (Expedia/Frontier confirmations are in my inbox).
5. **Expense tracking.** Start with voice logging ("spent $12 on lunch") into D1 or a Google Sheet. Weekly/monthly Telegram reports, on-demand questions ("food spend this week?"), budget alerts.
6. ~~**Whoop.**~~ Dropped 2026-11-01 (see decision log).
7. **Web search.** Use Claude's built-in web search; no custom tool needed.
8. **Bank integration.** PNC checking and the Barclays US Frontier Airlines credit card, both through Plaid (Free Trial with Production keys, 10 connections). Transactions only: up to 2 years of history, kept current with `/transactions/sync`. Voice tools `jarvis_connect_bank`, `jarvis_spending`, `jarvis_spending_page`, plus a spending-by-category-and-month page. Details and the Plaid build record: `PLAID_PLAN.md`. Later: voice adds context ("that Amazon charge was a gift").

## Phases

1. **Foundation** *(complete, 2026-11-01)*
   - [x] Restructure scaffold: flattened to repo root, calculator demo removed, one tool per file in `src/tools/`
   - [x] `ping` tool
   - [x] `save_note` tool → Telegram (secrets typed in `src/env.d.ts`, `.dev.vars.example`)
   - [x] Agentic tooling: `CLAUDE.md`, skills (`add-mcp-tool`, `add-oauth-integration` draft, `deploy`), type-check hook, `.mcp.json` docs servers
   - [x] Tests: Vitest in the Workers runtime, `ping` + `save_note` (Telegram mocked)
   - [x] Create Telegram bot, set secrets locally
   - [x] Test locally with MCP Inspector (`ping` and `save_note` verified, note delivered to Telegram)
   - [x] Set production secrets (`wrangler secret put`)
   - [x] Deploy (2026-11-01, `https://voice-assistant.vidyut-rajagopal2006.workers.dev/mcp`; live `ping` verified)
   - [x] Connect to the Claude app as a custom connector (no auth; both tools set to "Always allow" for smooth voice use)
   - [x] Test by voice
2. **Calendar and reminders** *(in progress)*
   - [x] OAuth-protected MCP server with Google sign-in, single allowed account (code and tests done)
   - [x] Google Cloud project, Calendar API, OAuth client (Web application), consent screen scopes and branding
   - [ ] Confirm consent screen is published "In production"
   - [x] Set Google secrets locally and in production
   - [x] Deploy the OAuth version (2026-11-01)
   - [ ] Re-add the connector in Claude, sign in, test by voice
   - [x] Default calendar chosen: Daily Life
   - [x] Calendar tools built and tested: `jarvis_add_event`, `jarvis_get_events`, `jarvis_list_calendars`
   - [x] Deploy calendar tools (2026-11-01, with Waresport Meet links and the "sock" nickname)
   - [x] Meet links on any calendar, repeating events, edit and delete tools (built and tested)
   - [x] Deploy edit, delete, repeat and Meet features (2026-11-01)
   - [x] Change or stop repeats on existing events; remove Meet links (deployed 2026-11-01)
   - [x] Test calendar tools by voice (Meet-link removal confirmed in Google Calendar)
   - [x] ~~Test Claude app's built-in Reminders~~ (done: built-in works, nothing to build)
3. **Expenses:** D1 schema, `log_expense`, `query_expenses`, weekly report cron, budget alerts.
4. **Gmail:** search, read, create_draft. No send.
5. **Bank integration (Plaid)** *(in progress)*
   - [x] D1 schema, Plaid client, encrypted tokens, webhook receiver with signature checks, Queue-driven paged sync, hourly/daily cron fallback
   - [x] Tools: `jarvis_connect_bank` (Hosted Link → Telegram, reconnect via update mode), `jarvis_spending`, `jarvis_spending_page`; `/spending` page
   - [x] Tests (Plaid mocked; real ES256 signature checks)
   - [x] Sandbox end-to-end run (2026-11-01): `npm run test:sandbox` and `npm run test:hosted-link` (Platypus OAuth Bank via Telegram Hosted Link, so no redirect URI needed)
   - [ ] Plaid company profile + latest MSA confirmed (PNC needs it)
   - [x] Create D1 `jarvis` + Queue `jarvis-bank-jobs`, apply migrations remotely, set production secrets, deploy (2026-11-01, version 6cbaf783)
   - [x] Connect PNC and Barclays by voice (2026-11-02)
   - [x] Transaction-level tools and page drill-down; richer Plaid fields; balances (tested in Sandbox)
6. **Maybe later:** a simple web dashboard for browsing notes (spending has its own page as of Phase 5).

## Dev environment

- macOS, VS Code, Claude Code (VS Code extension)
- Node.js 22+ via nvm (create-cloudflare requires it); version pinned in `.nvmrc`
- Private GitHub repo
- Test tools locally with MCP Inspector (`npx @modelcontextprotocol/inspector@latest`, Streamable HTTP, `http://localhost:8787/mcp`) before deploying

## Decision log

- **2026-11-01: Flattened repo layout.** The template was scaffolded into `voice-assistant/`; everything now lives at the repo root so code, docs and Claude Code config sit together. The Worker is still named `voice-assistant`.
- **2026-11-01: Tool pattern.** Each tool is a `defineTool({ name, description, inputSchema, handler(args, env) })` object in its own file, listed in `src/tools/index.ts`. Handlers are plain functions, so tests call them directly.
- **2026-11-01: Env reaches tools via closure.** The Agents SDK's stateless handler factory doesn't receive bindings, so `src/index.ts` builds the handler per request and passes `env` into each tool's handler.
- **2026-11-01: Spoken-reply helpers.** `speak()` / `speakError()` in `src/lib/respond.ts` produce every tool result. Errors set `isError` and use fixed, friendly sentences; details go only to logs.
- **2026-11-01: External API calls** live in `src/lib/`, return typed `{ ok } | { ok: false, reason }` results, never throw, and use a 10s timeout.
- **2026-11-01: Telegram notes use HTML parse mode** (bold title, then body), with all user text HTML-escaped. The bot token is in the request URL, so URLs are never logged. Note limits: title ≤ 100 characters, body ≤ 3500 (Telegram's cap is 4096).
- **2026-11-01: Testing.** Vitest 4 with `@cloudflare/vitest-plugin` (the renamed `@cloudflare/vitest-pool-workers`), with fake secrets in `vitest.config.ts`. A PostToolUse hook type-checks after every `.ts` edit.
- **2026-11-01: No extra protection on the authless endpoint in Phase 1.** Accepted risk: anyone with the URL could call tools (e.g. spam Telegram via `save_note`). Deploy only for testing and move to OAuth at the start of Phase 2.
- **2026-11-01: Preview URLs disabled** (`preview_urls: false`, `workers_dev: true` in `wrangler.jsonc`). Only the main workers.dev URL serves the Worker, so once OAuth lands, old unauthenticated versions can't be reached at per-version preview addresses.
- **2026-11-01: `ping` stays through Phase 2** as a connection check (the OAuth switch is when connections break). Later, replace it with a `status` tool that reports which integrations are configured or need reconnecting, without sending anything.
- **2026-11-01: Reminders use the Claude iOS app's built-in Apple Reminders access.** Tested by voice and it works completely, so Jarvis won't have a reminders tool. `save_note` remains for untimed ideas.
- **2026-11-01: Time zone is Eastern (`America/New_York`).** Use the IANA name, not a fixed EST offset, so daylight saving (EDT) is handled automatically. Calendar tools resolve relative dates ("next Thursday at 7") in this zone.
- **2026-11-01: OAuth design.** `@cloudflare/workers-oauth-provider` 1.2.4 (single-Worker `OAuthProvider`) protects `/mcp`; Claude connects with dynamic client registration, so the connector's OAuth Client ID/Secret fields stay empty. Sign-in goes through Google using the library's `beginConsent`/`beginUpstream` helpers (browser-bound single-use cookies, state, upstream PKCE).
- **2026-11-01: Single allowed account.** Only `ALLOWED_EMAIL` (verified by Google) can sign in; checked before any grant is issued and again on every request. Fails closed if unset.
- **2026-11-01: Google tokens live in the grant's props** (encrypted by the library), not a separate KV entry. Jarvis's access token expires 5 minutes before Google's so Claude's refresh also refreshes Google; tools fall back to a per-call refresh. Revoked Google access → grant revoked → Claude asks to sign in again. Grants stay alive while used at least every 90 days.
- **2026-11-01: Google scopes** are `openid email` (identity only; no name or photo) + `calendar.calendarlist.readonly` (list calendars) + `calendar.events` (create/edit events). No access to calendar settings, sharing or deletion of calendars. Both calendar scopes are requested at first sign-in so Phase 2's calendar tool needs no second sign-in.
- **2026-11-01: Google consent screen published "In production" without verification** (personal use, under 100 users). Testing mode would expire refresh tokens every 7 days. Trade-off: Google shows an "unverified app" warning at sign-in, which is expected for a personal app.
- **2026-11-01: Public home page and privacy policy** are served by the Worker at `/` and `/privacy` (static, no user data), because Google requires both links to publish the consent screen. No logo is uploaded, since a logo forces Google verification.
- **2026-11-01: Calendar tools.** `jarvis_add_event` (timed or all-day; end time or duration, default 60 min; optional calendar, location, notes), `jarvis_get_events` (a day or up to 7 days, across calendars visible in Google Calendar, or one named calendar), `jarvis_list_calendars`. Calendars are matched by name live from Google (exact, then a single partial match), ignoring case, spaces, punctuation and a trailing "calendar" so speech-to-text variants still match ("wares port" → Waresport, "S.O.C." → SOC). No calendar IDs are stored. The owner's calendars: Waresport, Career, Class, Daily Life (default), Exams, Research, SOC. Default calendar is a wrangler var (`DEFAULT_CALENDAR = "Daily Life"`), as is `TIME_ZONE`.
- **2026-11-01: Jarvis vs the phone's Apple Calendar.** Claude on iPhone also has built-in calendar access. Jarvis's calendar tools are prefixed `jarvis_`, their descriptions say to use them instead of the device calendar unless the user says "Apple calendar", and the user's Claude "Instructions for Claude" setting says the same. Reminders stay on the built-in Reminders app.
- **2026-11-01: Dates.** Tool descriptions include today's date and time zone (computed per request) so Claude resolves "next Thursday". Event times are sent to Google as wall-clock time plus `timeZone`, so Google handles daylight saving; only query ranges use offset math (tested on both DST changes). Every added event is read back with its full date and time so mistakes are caught immediately.
- **2026-11-01: Calendar nicknames and Meet links** are wrangler vars, not code. `CALENDAR_ALIASES` maps words speech-to-text gets wrong to calendar names (`sock` → SOC). `MEET_CALENDARS` lists calendars whose timed events automatically get a Google Meet link (Waresport); all-day events never do. Meet links are created via `conferenceData.createRequest` with a random `requestId` (so a retry can't create a second Meet), and are never read aloud; Jarvis just says the event has a Meet link.
- **2026-11-01: Repeating events, edits and deletes.** `jarvis_add_event` takes `add_meet_link` (any calendar; Waresport still defaults on) and `repeat` (daily/weekly on chosen days/monthly/yearly, every N, until a date or N times), stored as an RRULE; a weekly repeat on chosen days starts on the first of those days, and timed UNTIL is the end of that day in New York, in UTC. `jarvis_update_event` edits in place (keeps Meet links and IDs): new time/day/length, all-day on/off, title, location, notes, add Meet, or move to another calendar; time-only changes keep the event's length. `jarvis_delete_event` is marked destructive and Claude must confirm first. Events are found by title words (Google search, then title match) on the given day or the next 31 days on editable visible calendars; different matching events → Jarvis lists them and asks which. Repeating events: one occurrence by default, the whole series only when the user says all of them. Google limits respected: a whole series can't move to another day (time only), and only a whole series can move between calendars.
- **2026-11-01: Changing repeats and removing Meet links.** `jarvis_update_event` can make a one-off event repeat, replace a series' pattern, or stop it (`stop_repeating`); these always apply to the whole series, even if the user names one occurrence. Making an event repeat weekly on days that don't include its current day moves it to the first chosen day, so Google doesn't keep a stray occurrence. Stopping keeps past occurrences: the RRULE gets UNTIL = end of today (existing UNTIL/COUNT replaced, EXDATE/RDATE lines kept); a series that hasn't started yet becomes a single event on its first date. `add_meet_link: false` removes a Meet link (PATCH `conferenceData: null` with `conferenceDataVersion=1`; confirmed working on a live event by voice, 2026-11-01).
- **2026-11-01: Whoop dropped from the roadmap.** No longer wanted; bank integration takes its place as the next account integration.

- **2026-11-01: Bank integration via Plaid, inside Jarvis.** Barclays turned out to be the US Frontier Airlines card, so Plaid covers both banks (no GoCardless). Transactions only (no Liabilities consent; adding it later means one re-consent). `days_requested: 730`, fixed at first link. Category taxonomy pinned to PFC v2.
- **2026-11-01: Hosted Link, delivered by Telegram.** `jarvis_connect_bank` creates a Plaid Hosted Link session (1-hour link) and sends the URL to Telegram; it's never spoken. Plaid hosts the bank OAuth step, so no redirect URI is registered. The tool refuses to start a second connection to a bank already connected, and the completion step removes any duplicate Item it finds (duplicates are billed and use Free Trial connections). Reconnects use Plaid update mode on the same Item.
- **2026-11-01: Bank routes outside OAuth.** `POST /plaid/webhook` is public but acts only on a verified Plaid signature (ES256 JWT via `jose`, iat under 5 minutes, SHA-256 of the raw body). `/spending` serves a static shell; its data endpoint needs an HMAC-signed token that expires after 15 minutes. The token travels in the URL fragment so it never reaches server logs. No tool route is unauthenticated.
- **2026-11-01: Bank secrets.** `PLAID_CLIENT_ID`, `PLAID_SECRET` (per environment) and `JARVIS_SECRET_KEY` (32+ random bytes) as Worker secrets; `PLAID_ENV` is a var (`production` in wrangler.jsonc, `sandbox` in `.dev.vars`). Access and link tokens are AES-GCM encrypted in D1 with keys derived from `JARVIS_SECRET_KEY` (HKDF, one key per purpose). Rotating that secret makes stored bank connections unusable (reconnect each bank).
- **2026-11-01: Sync within the free plan's 10 ms CPU.** Webhooks and crons only enqueue. Each Queue job fetches one `/transactions/sync` page (250 transactions) into staging tables; when `has_more` is false one atomic D1 batch applies the staged adds/removals and the new cursor. Nothing partial is ever visible and the committed cursor never advances mid-loop. Every write is fenced on (run id, step), so duplicate deliveries are no-ops; a mutation-during-pagination error restarts from the run's starting cursor. Hourly cron: finish Link sessions whose webhook was missed and revive stuck runs; daily cron (11:30 UTC): catch-up sync.
- **2026-11-02: Transaction-level detail for Jarvis.** Owner wants as much structured data as possible so Claude can reason over it. Sync now requests `include_original_description` and stores raw bank text, time, location, website, logo, merchant ID, counterparties (marketplace / payment app), transaction code and check number, plus cached balances from `/accounts/get` (free with Transactions; not the billed real-time balance endpoint) after every sync. New read tools `jarvis_transactions` (filters: dates, text, category, account, amount range, direction, spending only; sort newest/oldest/largest) and `jarvis_accounts` (balances, owed/limit for cards and loans, history range, connection health); `jarvis_spending` gains `group_by` merchant/subcategory/month. Results are one record per line with fixed fields and money direction spelled out ("out"/"in"). The spending page lists the transactions behind any category-month cell and has a search box. Existing Items get the new fields through a one-time re-sync from an empty cursor on the hourly cron (`DATA_VERSION` in `src/bank/store.ts`); same Item, no new bank login.
- **2026-11-01: What counts as spending.** Purchases minus refunds, excluding transfers, loan and card payments, loan disbursements and income, so a PNC → Barclays card payment isn't double counted. Low-confidence categories show as "Uncategorized".

## Open risks

- ~~The server is public and unauthenticated until Phase 2.~~ Resolved once the OAuth version is deployed.

## Open questions

- ~~Is the Barclays account UK or US?~~ Resolved: US (Frontier Airlines credit card), via Plaid.
- ~~My Google calendar names and default~~ Resolved: Daily Life is the default.
