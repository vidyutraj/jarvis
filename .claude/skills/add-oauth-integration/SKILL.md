---
name: add-oauth-integration
description: How Jarvis's OAuth works (Google sign-in protecting the MCP server, Google tokens in the grant, refresh) and the pattern for adding a Google API tool or a second account provider such as a bank feed. Use when adding a tool that calls Google, changing scopes, or adding another account integration.
---

# OAuth in Jarvis

Before changing auth, re-read `@cloudflare/workers-oauth-provider`'s docs in `node_modules/@cloudflare/workers-oauth-provider/docs/`, especially `upstream-sign-in.md` and `consent-page.md`. The API changes between versions.

## How it works today

- **`src/index.ts`:** `OAuthProvider` wraps everything. `/mcp` is the only API route and needs a valid token. Claude registers itself through `/register` (dynamic client registration).
- **`src/auth/google-handler.ts`:** the sign-in flow.
    1. GET `/authorize` shows the consent page.
    2. POST `/authorize` runs `approveConsent` and `beginUpstream` (with a PKCE verifier), then redirects to Google.
    3. GET `/callback` runs `finishUpstream`, exchanges the code, then fetches userinfo.
    4. It checks that the email is verified and matches `ALLOWED_EMAIL`, and that the calendar scopes were granted.
    5. It calls `completeAuthorization` with `AuthProps`.
- **`AuthProps`** (`src/auth/props.ts`): `sub`, `email` and the Google access token, refresh token and expiry. The library stores them encrypted with the grant.
- **`src/auth/token-exchange.ts`:**
    - Jarvis's access token lifetime is set to Google's minus 5 minutes.
    - Each Claude refresh also refreshes Google's token, and the result is saved in `newProps`.
    - Google `invalid_grant` → throw `OAuthError("invalid_grant")`. The grant is revoked and Claude signs in again.
    - Anything else → throw `temporarily_unavailable`.
- **`src/index.ts` API handler:** re-checks `isAuthProps` and the allowlist on every request, then passes `{ env, auth }` to tools as `ToolContext`.
- **Storage:** KV binding `OAUTH_KV` holds the library's clients, grants and tokens, with props encrypted.
- **Grant lifetime:** a grant stays alive while it's used at least every 90 days (`refreshTokenIdleTTL`).

## Adding a tool that calls a Google API

1. Get a token with `const token = await getGoogleAccessToken(context.auth, context.env)` (from `src/lib/google-auth.ts`). It refreshes for the current call if needed. Props are read-only in tools, and that's fine because Google doesn't rotate refresh tokens.
2. If it fails, return `speakError(GOOGLE_ACCESS_FAILURE_REPLIES[token.reason])`.
3. Put the API calls in `src/lib/google-<api>.ts`, following the add-mcp-tool rules (typed result, timeout, never throw, no token logging).
4. A 401 from Google means the token is dead: refresh once and retry once. A 403 usually means a missing scope.

## Changing Google scopes

- Edit `GOOGLE_CALENDAR_SCOPES` / `GOOGLE_SCOPES` in `src/lib/google-oauth.ts`. Always request the narrowest scope that works, and record the scope and the reason in `docs/PROJECT_CONTEXT.md`.
- If a new scope is required, check it in `handleGoogleCallback` the way the calendar scopes are checked.
- Existing grants don't have new scopes. The user must remove the connector in Claude, add it again and sign in, so mention this when shipping.
- New scopes may also need adding on the Google Cloud consent screen.

## Adding a second provider (e.g. a bank feed, Phase 5)

- Jarvis's login stays Google. Connect the other provider separately rather than as a second sign-in:
    - Routes `/connect/<provider>` and `/connect/<provider>/callback`. These must only be reachable by the signed-in owner, so require a valid Jarvis session or a short-lived signed link a tool hands out.
    - Store the provider's tokens in KV under `oauth:<provider>`, encrypted with AES-GCM using a key from a Worker secret.
    - Use a one-time `state` with a TTL.
    - Use PKCE if the provider supports it.
- Refresh pattern: `getAccessToken` returns the stored token if it's valid for more than 60 seconds. Otherwise it refreshes, saves the result (keeping the old refresh token if none is returned), and on `invalid_grant` returns `needs_reconnect`.
- Webhooks (e.g. bank transaction updates) must verify the provider's signature before trusting the payload.

## Security checklist

- Never log tokens, codes, client secrets, or URLs containing them.
- Escape everything client-supplied on HTML pages (`escapeHtml` in `src/auth/pages.ts`).
- Fail closed: no `ALLOWED_EMAIL` means nobody gets in.
- `MCP_RESOURCE` must equal the connector URL exactly. Changing it invalidates all grants.
- Tests (see `test/oauth-flow.test.ts`) run the real Worker end-to-end with only the provider's endpoints faked. Cover wrong account, missing scope, refresh and revocation.
