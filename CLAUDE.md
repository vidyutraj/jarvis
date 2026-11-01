# Jarvis

A personal voice assistant: the user talks to Claude in the Claude app's voice mode, and this repo is a remote MCP server that gives Claude custom tools (notes, calendar, expenses, bank transactions, Gmail drafts). Background, decisions and the roadmap live in `docs/PROJECT_CONTEXT.md`. Read it before planning new work.

**Stack:** Cloudflare Workers, MCP via the Agents SDK (`agents/mcp/server` + `@modelcontextprotocol/server`), OAuth via `@cloudflare/workers-oauth-provider` (Google sign-in), D1, KV, Telegram Bot API. Vitest with `@cloudflare/vitest-plugin`.

## Non-negotiable rules

- **Spoken replies:** every tool result is read aloud. Return one or two short sentences that sound natural spoken, using `speak()` / `speakError()` from `src/lib/respond.ts`. No markdown, IDs, URLs or raw errors. Read tools (e.g. calendar lookups) may return a compact plain-text list that Claude summarises; confirmations and errors stay short.
- **Calendar:** tools are prefixed `jarvis_` and their descriptions tell Claude to use them instead of the phone's built-in calendar. Times are wall-clock in `TIME_ZONE` (wrangler var); write tools read back the exact date and time.
- **Tool descriptions** are clear and specific: what the tool does, exactly when to use it, and how to prepare the input.
- **Secrets** come only from `wrangler secret put` (production) or `.dev.vars` (local, gitignored). Never put them in code, tests, logs or error messages.
- **The Gmail integration must NEVER have a send tool.** Search, read and create_draft only.
- **Destructive tools** (e.g. `jarvis_delete_event`) set `destructiveHint: true` and their description tells Claude to confirm the exact item with the user before calling. Prefer edits over delete-and-recreate.
- One tool per file in `src/tools/`, registered in `src/tools/index.ts`. Follow the `add-mcp-tool` skill.
- External API calls live in `src/lib/`. They return typed results, never throw, and always use a timeout.
- **Bank (Plaid):** follow `PLAID_PLAN.md`; consult the Plaid MCP's `build_guidance` before changing Plaid code and re-run `build_check_acceptance` after. Access/link tokens are encrypted in D1 and never logged (log `request_id` / `link_session_id` only). `/plaid/webhook` must verify Plaid's signature before doing anything; bank work runs as small Queue jobs (free plan: 10 ms CPU per invocation).
- **Auth:** `/mcp` is OAuth-protected; only `ALLOWED_EMAIL` can sign in (checked at sign-in and on every request). Never add an unauthenticated route to tools. Tools get the signed-in user via `context.auth`; Google calls use `getGoogleAccessToken()` from `src/lib/google-auth.ts`. Never log tokens, codes or URLs containing them.

## Commands

| Command              | Purpose                                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`        | Local server at `http://localhost:8787/mcp`                                                                                 |
| `npm test`           | Vitest in the Workers runtime                                                                                               |
| `npm run test:sandbox` | Plaid Sandbox end-to-end tests (real Sandbox keys from `.dev.vars`) |
| `npm run test:hosted-link` | Interactive: sends a Sandbox Hosted Link to Telegram and waits for you to finish it |
| `npm run type-check` | TypeScript for `src/` and `test/`                                                                                           |
| `npm run lint`       | oxlint                                                                                                                      |
| `npm run deploy`     | `wrangler deploy` (prefer `/deploy`, which checks first)                                                                    |
| `npm run cf-typegen` | Regenerate `worker-configuration.d.ts` after binding changes (move `.dev.vars` aside first so secrets aren't typed as vars) |
| `npx wrangler d1 migrations apply jarvis --local` (or `--remote`) | Apply D1 migrations in `migrations/` |

Test new tools locally with MCP Inspector before deploying: `npx @modelcontextprotocol/inspector@latest`, then Streamable HTTP and `http://localhost:8787/mcp`. Connecting opens Jarvis's consent page, then Google sign-in (`.dev.vars` needs the Google secrets and `MCP_RESOURCE=http://localhost:8787/mcp`).

## Keeping docs current

Whenever we make a design decision, finish a phase, add a tool or change a convention, update in the same commit:

- `docs/PROJECT_CONTEXT.md`: decisions, roadmap status, resolved open questions
- `CLAUDE.md`: rules and commands only

Keep this file concise. Background belongs in PROJECT_CONTEXT.md.

@AGENTS.md
