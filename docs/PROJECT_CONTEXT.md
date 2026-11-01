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
- **Storage:** D1 (SQLite) for expenses, notes history, Whoop data; KV for OAuth tokens
- **Scheduled jobs:** Cloudflare Cron Triggers (weekly/monthly reports via the Claude API)
- **Notifications:** Telegram bot (free; chosen over SMS, which costs money)
- **Secrets:** `wrangler secret put` in production, `.dev.vars` locally (gitignored)

## Features and decisions

1. **Voice notes → Telegram.** I ramble, Claude tidies it into a note, it's sent to me on Telegram. For capturing ideas; no time attached.
2. **Calendar events.** Google Calendar API. I have multiple calendars (e.g. Work, Personal), so the tool takes a calendar name mapped to calendar IDs, with a default. Always give Claude the current date and my time zone so "next Thursday" resolves correctly.
3. **Reminders.** Must land in the **Apple Reminders app** on my iPhone (not Google Tasks). Apple has no web API. First, test whether the Claude iOS app's built-in Reminders access is enough. Fallback: an iOS Shortcut that polls this server and adds reminders. Reminders are for "do this at a specific time"; notes are for "remember this idea."
4. **Gmail drafts.** Flow: "What was the last email from X?" → Claude reads/summarises → I say my reply → saved as a draft in the same thread. Optional Telegram ping: "draft ready." Also useful for finding flight details (Expedia/Frontier confirmations are in my inbox).
5. **Expense tracking.** Start with voice logging ("spent $12 on lunch") into D1 or a Google Sheet. Weekly/monthly Telegram reports, on-demand questions ("food spend this week?"), budget alerts.
6. **Whoop.** Official Whoop developer API (free) plus webhooks pushing sleep, recovery, strain and workouts into D1. Mostly on-demand questions. Once the data is stored, any question about it is possible.
7. **Web search.** Use Claude's built-in web search; no custom tool needed.
8. **Bank integration (later, but I want it).** I have PNC and Barclays personal checking accounts. Plaid for PNC. Barclays: confirm whether it's a UK account; if so, GoCardless Bank Account Data. Plan: bank feed pulls transactions automatically, voice adds context ("that Amazon charge was a gift").

## Phases

1. **Foundation:** restructure scaffold, `ping` and `save_note` tools, Telegram, agentic tooling (skills, hooks, tests), deploy, connect to Claude app, test by voice.
2. **Calendar and reminders:** switch to an OAuth-protected MCP server first (the authless template is public), then Google OAuth and `create_event`. Test Claude app's built-in Reminders.
3. **Expenses:** D1 schema, `log_expense`, `query_expenses`, weekly report cron, budget alerts.
4. **Gmail:** search, read, create_draft. No send.
5. **Whoop:** OAuth, webhook endpoint, D1 storage, `query_health`.
6. **Bank integration:** Plaid (PNC), possibly GoCardless (Barclays).
7. **Maybe later:** a simple web dashboard for browsing notes, spending and health trends.

## Dev environment

- macOS, VS Code, Claude Code (VS Code extension)
- Node.js 22+ via nvm (create-cloudflare requires it); version pinned in `.nvmrc`
- Private GitHub repo
- Test tools locally with MCP Inspector (`npx @modelcontextprotocol/inspector@latest`, Streamable HTTP, `http://localhost:8787/mcp`) before deploying

## Open questions

- Is the Barclays account UK or US?
- My Google calendar names and IDs (needed in Phase 2)
- My time zone setting for the calendar and reminder tools
- Does the Claude iOS app's built-in Reminders access cover my needs?
