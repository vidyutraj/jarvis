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

## Tools

| Tool        | What it does                    |
| ----------- | ------------------------------- |
| `ping`      | Confirms the server is live     |
| `save_note` | Sends a tidied note to Telegram |

> **Security note:** until Phase 2 adds OAuth, the server has no authentication. Anyone with the URL can call its tools.
