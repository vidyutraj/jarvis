---
name: add-mcp-tool
description: The house pattern for adding a new MCP tool to the Jarvis server (file in src/tools/, zod schema, description, short speakable reply, error handling, test, registration). Use whenever adding or substantially changing a tool.
---

# Adding an MCP tool

Every tool result is read aloud in Claude's voice mode. Follow every step below.

## 1. Create `src/tools/<kebab-name>.ts`

```ts
import { z } from "zod";
import { speak, speakError } from "../lib/respond";
import { defineTool } from "./types";

export const exampleTool = defineTool({
	name: "snake_case_name",
	description:
		"What it does, exactly when Claude should use it (and when not), and how to prepare the input.",
	inputSchema: z.object({
		field: z.string().trim().min(1).max(200).describe("What this is, with an example."),
	}),
	handler: async ({ field }, env) => {
		const result = await someLibCall(env, field); // returns { ok: true } | { ok: false, reason }
		if (!result.ok) return speakError("One short sentence saying what didn't happen.");
		return speak("One short sentence confirming what happened.");
	},
});
```

### Rules

- **Description:** be specific. Say when to use the tool, how it differs from similar tools, and how to clean up spoken input before calling. Claude chooses tools from this text alone.
- **Schema:** use `z.object`. Give every field `.describe()` and sensible limits (`.min`, `.max`, `.trim`, enums). Never accept unbounded strings.
- **Replies:** use only `speak()` and `speakError()`. One or two short sentences that sound natural spoken aloud: no markdown, IDs, URLs, stack traces or raw API errors.
- **External calls:** put them in `src/lib/<service>.ts`. They return a typed result union and never throw. Also:
    - Use `AbortSignal.timeout(...)` on every fetch.
    - Catch network errors.
    - Log only safe details (status code, the API's error description).
- **Secrets:** read them from `env`, add them to `JarvisSecrets` in `src/env.d.ts`, and add placeholders to `.dev.vars.example`.
    - Never hardcode secrets.
    - Never log a secret, or a URL that contains one.
- **Read-only by default:** don't add destructive or outward-sending capability unless it was explicitly decided in `docs/PROJECT_CONTEXT.md`. Gmail must never get a send tool.

## 2. Register it

Add it to the `tools` array in `src/tools/index.ts`.

## 3. Test it in `test/<kebab-name>.test.ts`

- Call `tool.handler(args, testEnv())` directly (helpers are in `test/helpers.ts`).
- Mock outbound calls with `vi.spyOn(globalThis, "fetch")`. Never hit real APIs.
- Cover success and every failure reason. Use `expectSpeakable(result)` on each reply.
- Add test-only fake secrets to `vitest.config.ts` under `miniflare.bindings`.

## 4. Verify

1. `npm run type-check`, `npm run lint` and `npm test` all pass.
2. Run `npm run dev` and try the tool in MCP Inspector: `npx @modelcontextprotocol/inspector@latest`, Streamable HTTP, `http://localhost:8787/mcp`.
3. Update `docs/PROJECT_CONTEXT.md` (features, roadmap status, decisions) in the same commit. Update `CLAUDE.md` only if a rule or command changed.
