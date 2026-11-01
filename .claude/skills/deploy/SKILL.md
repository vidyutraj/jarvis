---
name: deploy
description: Deploy the Jarvis MCP server to Cloudflare Workers after checking docs, types, lint and tests.
disable-model-invocation: true
---

# Deploy

Run these steps in order. **Stop at the first failure**, report it in one or two sentences, and do not deploy.

1. **Docs are current.**
    - Review what's changing: `git status`, `git diff`, and `git log` since the last deploy.
    - Make sure `docs/PROJECT_CONTEXT.md` reflects it: features, roadmap status, decisions, resolved open questions.
    - Make sure `CLAUDE.md` reflects any changed rules or commands.
    - Update either file if needed and show the user what changed.
2. **Secrets exist.** Run `npx wrangler secret list` and confirm every key in `.dev.vars.example` is set in production. If any are missing, tell the user to run `npx wrangler secret put <NAME>`. Never set secrets yourself or print their values.
3. **Type-check:** `npm run type-check`
4. **Lint:** `npm run lint`
5. **Test:** `npm test`
6. **Audit:** `npm audit --omit=dev`. Report any high or critical issues and ask before continuing.
7. **Deploy:** `npx wrangler deploy`
8. **Report:**
    - Give the deployed URL, with `/mcp` appended for the Claude connector.
    - Remind the user to test by voice.
    - Note any uncommitted changes. Don't commit unless asked.
