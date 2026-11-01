import type { CallToolResult } from "@modelcontextprotocol/server";
import { env } from "cloudflare:workers";
import { expect } from "vitest";
import type { AuthProps } from "../src/auth/props";
import type { ToolContext } from "../src/tools";

/** Test env with fake secrets (see vitest.config.ts), with optional overrides. */
export function testEnv(overrides: Partial<Env> = {}): Env {
	return { ...env, ...overrides };
}

export function testAuth(overrides: Partial<AuthProps> = {}): AuthProps {
	return {
		sub: "google-sub-123",
		email: "owner@example.com",
		googleAccessToken: "google-access-token",
		googleRefreshToken: "google-refresh-token",
		googleExpiresAt: Date.now() + 3_600_000,
		...overrides,
	};
}

export function testContext(envOverrides: Partial<Env> = {}): ToolContext {
	return { env: testEnv(envOverrides), auth: testAuth() };
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

/** Speakable check for plain reply strings (e.g. failure reply tables). */
export function expectSpeakableText(text: string): void {
	expectSpeakable({ content: [{ type: "text", text }] });
}

export function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
