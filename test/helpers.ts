import type { CallToolResult } from "@modelcontextprotocol/server";
import { env } from "cloudflare:workers";
import { expect } from "vitest";

/** Test env with fake Telegram secrets (see vitest.config.ts), with optional overrides. */
export function testEnv(overrides: Partial<Env> = {}): Env {
	return { ...env, ...overrides };
}

export function resultText(result: CallToolResult): string {
	const [first] = result.content;
	if (first?.type !== "text") throw new Error("Expected a text result");
	return first.text;
}

/** Voice rule: replies must be one or two short sentences. */
export function expectSpeakable(result: CallToolResult): void {
	const text = resultText(result);
	expect(text.length).toBeLessThanOrEqual(160);
	const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
	expect(sentences.length).toBeLessThanOrEqual(2);
}
