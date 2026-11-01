# Jarvis

A personal voice assistant. Claude (in the Claude app's voice mode) is the brain, and this repo is a remote MCP server on Cloudflare Workers that gives it custom tools.

- Background, decisions and roadmap: [docs/PROJECT_CONTEXT.md](docs/PROJECT_CONTEXT.md)
- Rules and commands for working on the code: [CLAUDE.md](CLAUDE.md)

## Local setup

```sh
nvm use
npm install
cp .dev.vars.example .dev.vars   # then fill in real values
npm run dev                      # http://localhost:8787/mcp
```

### Telegram secrets

1. Message [@BotFather](https://t.me/BotFather), send `/newbot` and copy the token into `TELEGRAM_BOT_TOKEN`.
2. Send your new bot any message, then open `https://api.telegram.org/bot<TOKEN>/getUpdates`. Copy `message.chat.id` into `TELEGRAM_CHAT_ID`.

For production, run `npx wrangler secret put TELEGRAM_BOT_TOKEN` and `npx wrangler secret put TELEGRAM_CHAT_ID`.

### Google sign-in

Jarvis is OAuth-protected: connecting (from Claude or MCP Inspector) shows a consent page, then Google sign-in. Only `ALLOWED_EMAIL` gets in.

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the **Google Calendar API**.
2. Set up the OAuth consent screen (External), add the scopes `calendar.calendarlist.readonly` and `calendar.events`, then **publish the app** ("In production"). Testing mode expires sign-ins every 7 days.
3. Create an OAuth client (type **Web application**) with these authorized redirect URIs:
    - `https://voice-assistant.<your-subdomain>.workers.dev/callback`
    - `http://localhost:8787/callback`
4. Put the client ID, client secret and your email in `.dev.vars` (see `.dev.vars.example`), and in production with `npx wrangler secret put GOOGLE_CLIENT_ID` (and `GOOGLE_CLIENT_SECRET`, `ALLOWED_EMAIL`).

In the Claude app, add the connector with just the URL; leave the OAuth Client ID/Secret fields empty.

## Tools

| Tool                    | What it does                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| `ping`                  | Confirms the server is live                                                                                   |
| `save_note`             | Sends a tidied note to Telegram                                                                               |
| `jarvis_add_event`      | Adds an event, one-off or repeating, optionally with a Meet link (default calendar: Daily Life)               |
| `jarvis_update_event`   | Moves or changes an event: time, day, title, calendar, add/remove Meet link, make it repeat or stop repeating |
| `jarvis_delete_event`   | Deletes an event after you confirm                                                                            |
| `jarvis_get_events`     | Says what's on your calendar for a day or a few days                                                          |
| `jarvis_list_calendars` | Lists your Google calendars                                                                                   |
