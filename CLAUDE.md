# Jarvis

A personal voice assistant: the user talks to Claude in the Claude app's voice mode, and this repo is a remote MCP server that gives Claude custom tools (notes, calendar, expenses, Gmail drafts, health data). Background, decisions and the roadmap live in `docs/PROJECT_CONTEXT.md`. Read it before planning new work.

**Stack:** Cloudflare Workers, MCP via the Agents SDK (`agents/mcp/server` + `@modelcontextprotocol/server`), D1, KV, Telegram Bot API. Vitest with `@cloudflare/vitest-plugin`.

## Non-negotiable rules

- **Spoken replies:** every tool result is read aloud. Return one or two short sentences that sound natural spoken, using `speak()` / `speakError()` from `src/lib/respond.ts`. No markdown, IDs, URLs or raw errors.
- **Tool descriptions** are clear and specific: what the tool does, exactly when to use it, and how to prepare the input.
- **Secrets** come only from `wrangler secret put` (production) or `.dev.vars` (local, gitignored). Never put them in code, tests, logs or error messages.
- **The Gmail integration must NEVER have a send tool.** Search, read and create_draft only.
- One tool per file in `src/tools/`, registered in `src/tools/index.ts`. Follow the `add-mcp-tool` skill.
- External API calls live in `src/lib/`. They return typed results, never throw, and always use a timeout.

## Commands

| Command              | Purpose                                                      |
| -------------------- | ------------------------------------------------------------ |
| `npm run dev`        | Local server at `http://localhost:8787/mcp`                  |
| `npm test`           | Vitest in the Workers runtime                                |
| `npm run type-check` | TypeScript for `src/` and `test/`                            |
| `npm run lint`       | oxlint                                                       |
| `npm run deploy`     | `wrangler deploy` (prefer `/deploy`, which checks first)     |
| `npm run cf-typegen` | Regenerate `worker-configuration.d.ts` after binding changes |

Test new tools locally with MCP Inspector before deploying: `npx @modelcontextprotocol/inspector@latest`, then Streamable HTTP and `http://localhost:8787/mcp`.

## Keeping docs current

Whenever we make a design decision, finish a phase, add a tool or change a convention, update in the same commit:

- `docs/PROJECT_CONTEXT.md`: decisions, roadmap status, resolved open questions
- `CLAUDE.md`: rules and commands only

Keep this file concise. Background belongs in PROJECT_CONTEXT.md.

@AGENTS.md
