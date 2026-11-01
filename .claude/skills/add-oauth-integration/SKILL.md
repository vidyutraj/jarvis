---
name: add-oauth-integration
description: DRAFT pattern for connecting a third-party OAuth 2.0 API (Google Calendar/Gmail, Whoop) with tokens stored in KV and automatic refresh. Use when adding an integration that needs the user's account access. To be refined in Phase 2.
---

# Adding an OAuth integration (draft, refine in Phase 2)

> This draft hasn't been used yet. Before building, fetch current docs (Cloudflare docs MCP and Agents docs MCP for KV and OAuth helpers, plus the provider's OAuth docs) and update this skill with what you learn.

**Prerequisite:** the MCP server itself must be OAuth-protected before any account integration ships (start of Phase 2). The authless server is public, and a public endpoint must never reach the user's Google or Whoop data.

## Storage

- KV namespace binding `OAUTH_TOKENS`, declared in `wrangler.jsonc`. Run `npm run cf-typegen` after adding it.
- Key: `oauth:<provider>` (single user). Value: JSON `{ access_token, refresh_token, expires_at, scope }`, where `expires_at` is epoch ms.
- Client ID and secret come from `wrangler secret put` / `.dev.vars`, never from KV or code.

## Flow

1. **`GET /oauth/<provider>/start`:**
    - Generate a random `state` and store it in KV with a TTL of about 10 minutes.
    - Redirect to the provider's consent URL with the minimal scopes. Gmail gets `gmail.readonly` + `gmail.compose`, never full send scopes.
2. **`GET /oauth/<provider>/callback`:**
    - Verify `state` matches and delete it (one-time use).
    - Exchange the code for tokens and store them.
    - Show a plain "Connected" page.
3. **`src/lib/oauth.ts` → `getAccessToken(env, provider)`:**
    - Return the stored token if it's valid for more than 60 seconds.
    - Otherwise refresh with the refresh token and save the new tokens. Keep the old refresh token if the provider doesn't return a new one.
    - On `invalid_grant` or a missing token, return `{ ok: false, reason: "needs_reconnect" }`.
4. **API calls (`src/lib/<provider>.ts`):** on a 401, refresh once and retry once. Never loop.

## Tool replies

- `needs_reconnect` → "I've lost access to your <Provider> account. Reconnect it and try again."
- Other failures → one short sentence, following the add-mcp-tool rules.

## Security

- Never log tokens, codes or URLs that contain them.
- Request the least-privilege scopes, documented in `docs/PROJECT_CONTEXT.md`.
- The callback must reject a missing or mismatched `state`.
- Tests mock the token endpoint and the API, covering valid token, refresh, refresh failure and 401 retry.

## Provider notes

- **Google:** offline access (`access_type=offline`, `prompt=consent`) is needed to get a refresh token.
- **Whoop:** official developer API. Webhooks for sleep, recovery and workouts come later (Phase 5) and must verify the webhook signature.
