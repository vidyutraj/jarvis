import type {
	BetaMessage,
	MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ASK_REPLIES, runAsk, toSpeech, type CreateMessage } from "../src/ask/agent";
import { rememberGoogleSignIn } from "../src/ask/google-signin";
import { ASK_ROUTE_REPLIES, handleAskRoute } from "../src/ask/route";
import { speak } from "../src/lib/respond";
import { deleteEventTool } from "../src/tools/delete-event";
import { defineTool, type Tool } from "../src/tools/types";
import { jsonResponse, testAuth, testContext, testEnv } from "./helpers";

function resolveDescription(tool: Tool): string {
	return typeof tool.description === "function"
		? tool.description(testContext())
		: tool.description;
}

const ASK_KEY = "test-ask-key-0123456789abcdefghijklmnop";

/** Test env whose rate limiter always allows (or always refuses) a request. */
function askEnv(overrides: Partial<Env> = {}, allow = true): Env {
	const limiter = { limit: async () => ({ success: allow }) } as unknown as RateLimit;
	return testEnv({ ASK_LIMITER: limiter, ...overrides });
}

function message(
	content: BetaMessage["content"],
	stop_reason: BetaMessage["stop_reason"],
): BetaMessage {
	return {
		id: "msg_test",
		type: "message",
		role: "assistant",
		model: "claude-opus-5-5",
		content,
		stop_reason,
		stop_sequence: null,
		usage: { input_tokens: 1, output_tokens: 1 },
	} as unknown as BetaMessage;
}

const text = (value: string) => ({ type: "text", text: value, citations: null }) as const;
const toolUse = (id: string, name: string, input: unknown) =>
	({ type: "tool_use", id, name, input }) as const;

/** Collects waitUntil work so tests can wait for after-reply bookkeeping. */
let pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (promise: Promise<unknown>) => void pending.push(promise) };
const settle = async () => {
	await Promise.all(pending);
	pending = [];
};

/** A fake Claude that plays back scripted responses and records every request. */
function scriptedClaude(responses: BetaMessage[]) {
	const requests: MessageCreateParamsNonStreaming[] = [];
	const createMessage: CreateMessage = async (params) => {
		requests.push(structuredClone(params));
		const next = responses.shift();
		if (!next) throw new Error("No scripted response left");
		return next;
	};
	return { createMessage, requests };
}

function askRequest(body: unknown, key: string | null = ASK_KEY, method = "POST"): Request {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (key !== null) headers.Authorization = `Bearer ${key}`;
	return new Request("https://jarvis.test/ask", {
		method,
		headers,
		...(method === "POST"
			? { body: typeof body === "string" ? body : JSON.stringify(body) }
			: {}),
	});
}

/** Google's token endpoint answers refreshes; any other fetch fails the test. */
function mockGoogleRefresh(ok = true) {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url.startsWith("https://oauth2.googleapis.com/token")) {
			return ok
				? jsonResponse({ access_token: "fresh-google-token", expires_in: 3600, scope: "" })
				: jsonResponse({ error: "invalid_grant" }, 400);
		}
		throw new Error(`Unexpected fetch to ${url}`);
	});
}

beforeEach(async () => {
	pending = [];
	await env.OAUTH_KV.delete("jarvis:ask:google-signin");
	await env.OAUTH_KV.delete("jarvis:ask:history");
	vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("/ask route", () => {
	it("ignores other paths", async () => {
		expect(
			await handleAskRoute(new Request("https://jarvis.test/mcp"), testEnv(), ctx),
		).toBeNull();
	});

	it("only accepts POST", async () => {
		const response = await handleAskRoute(askRequest(null, ASK_KEY, "GET"), askEnv(), ctx);
		expect(response?.status).toBe(405);
	});

	it("rejects a missing or wrong key without calling Claude", async () => {
		const claude = scriptedClaude([]);
		for (const key of [null, "wrong-key", `${ASK_KEY}x`]) {
			const response = await handleAskRoute(
				askRequest({ text: "hi" }, key),
				askEnv(),
				ctx,
				claude,
			);
			expect(response?.status).toBe(401);
			expect(await response?.text()).toBe(ASK_ROUTE_REPLIES.unauthorized);
		}
		expect(claude.requests).toHaveLength(0);
	});

	it("refuses to run when the key isn't configured or is too short", async () => {
		for (const JARVIS_ASK_KEY of ["", "short"]) {
			const response = await handleAskRoute(
				askRequest({ text: "hi" }, JARVIS_ASK_KEY || "anything"),
				askEnv({ JARVIS_ASK_KEY }),
				ctx,
			);
			expect(response?.status).toBe(503);
		}
	});

	it("rejects a body without text", async () => {
		for (const body of ["not json", { text: "   " }, { question: "hi" }, "x".repeat(9000)]) {
			const response = await handleAskRoute(askRequest(body), askEnv(), ctx);
			expect(response?.status).toBe(400);
		}
	});

	it("asks for a Google sign-in when none has been saved yet", async () => {
		const response = await handleAskRoute(askRequest({ text: "hi" }), askEnv(), ctx);
		expect(await response?.text()).toBe(ASK_ROUTE_REPLIES.needsSignIn);
	});

	it("is rate limited before the key is checked", async () => {
		const response = await handleAskRoute(
			askRequest({ text: "hi" }, "wrong"),
			askEnv({}, false),
			ctx,
		);
		expect(response?.status).toBe(429);
		expect(await response?.text()).toBe(ASK_ROUTE_REPLIES.tooFast);
	});

	it("answers as the owner, runs tools, and remembers the exchange for a follow-up", async () => {
		mockGoogleRefresh();
		await rememberGoogleSignIn(testEnv(), testAuth());
		// Stored encrypted: the refresh token never sits in KV in the clear.
		const stored = await env.OAUTH_KV.get("jarvis:ask:google-signin");
		expect(stored).toBeTruthy();
		expect(stored).not.toContain("google-refresh-token");

		const claude = scriptedClaude([
			message([toolUse("t1", "jarvis_accounts", {})], "tool_use"),
			message([text("**Yes**, Jarvis is live. See https://example.com")], "end_turn"),
			message([text("Still here.")], "end_turn"),
		]);
		const first = await handleAskRoute(
			askRequest({ text: "Are you working?" }),
			askEnv(),
			ctx,
			claude,
		);
		expect(first?.status).toBe(200);
		expect(first?.headers.get("Content-Type")).toContain("text/plain");
		expect(await first?.text()).toBe("Yes, Jarvis is live. See");

		const [round1, round2] = claude.requests;
		expect(round1?.model).toBe("claude-haiku-5-5");
		// Haiku has no server-side refusal fallback, so the beta isn't sent.
		expect(round1).not.toHaveProperty("fallbacks");
		expect(round1).not.toHaveProperty("betas");
		// Quick commands on Haiku skip thinking for speed.
		expect(round1?.thinking).toEqual({ type: "disabled" });
		expect(round1?.tools?.map((tool) => ("name" in tool ? tool.name : ""))).toContain(
			"jarvis_get_events",
		);
		// The real tool ran in-process and its spoken result went back to Claude.
		expect(round2?.messages[round2.messages.length - 1]).toMatchObject({
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "t1", content: expect.any(String) }],
		});

		// A follow-up within a few minutes sees the previous exchange (saved after the reply).
		await settle();
		await handleAskRoute(askRequest({ text: "And now?" }), askEnv(), ctx, claude);
		const followUp = claude.requests[2]!;
		expect(followUp.messages.slice(0, 3)).toEqual([
			{ role: "user", content: "Are you working?" },
			{ role: "assistant", content: "Yes, Jarvis is live. See" },
			{ role: "user", content: "And now?" },
		]);
	});

	it("never offers a tool that sends email", async () => {
		mockGoogleRefresh();
		await rememberGoogleSignIn(testEnv(), testAuth());
		const claude = scriptedClaude([message([text("Ok.")], "end_turn")]);
		await handleAskRoute(askRequest({ text: "hi" }), askEnv(), ctx, claude);
		const names =
			claude.requests[0]?.tools?.map((tool) => ("name" in tool ? tool.name : "")) ?? [];
		expect(names.some((name) => /send|email|gmail/i.test(name))).toBe(false);
	});

	it("reuses the saved Google token instead of refreshing on every question", async () => {
		const fetchSpy = mockGoogleRefresh();
		await rememberGoogleSignIn(
			testEnv(),
			testAuth({ googleExpiresAt: Date.now() + 3_600_000 }),
		);
		const claude = scriptedClaude([message([text("Ok.")], "end_turn")]);
		await handleAskRoute(askRequest({ text: "hi" }), askEnv(), ctx, claude);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("refreshes a nearly expired Google token once and saves it for next time", async () => {
		const fetchSpy = mockGoogleRefresh();
		await rememberGoogleSignIn(testEnv(), testAuth({ googleExpiresAt: Date.now() + 60_000 }));
		const claude = scriptedClaude([
			message([text("One.")], "end_turn"),
			message([text("Two.")], "end_turn"),
		]);
		await handleAskRoute(askRequest({ text: "first" }), askEnv(), ctx, claude);
		await settle();
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		await handleAskRoute(askRequest({ text: "second" }), askEnv(), ctx, claude);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("keeps only the last five exchanges as follow-up memory", async () => {
		mockGoogleRefresh();
		await rememberGoogleSignIn(testEnv(), testAuth());
		const replies = Array.from({ length: 7 }, (_, i) =>
			message([text(`Answer ${i}.`)], "end_turn"),
		);
		const claude = scriptedClaude(replies);
		for (let i = 0; i < 7; i++) {
			await handleAskRoute(askRequest({ text: `Question ${i}` }), askEnv(), ctx, claude);
			await settle();
		}
		const last = claude.requests[6]!;
		// 5 earlier exchanges (2 messages each) + the new question.
		expect(last.messages).toHaveLength(11);
		expect(last.messages[0]).toEqual({ role: "user", content: "Question 1" });
	});

	it("deletes without asking first on /ask, while the Claude app keeps the confirm rule", async () => {
		mockGoogleRefresh();
		await rememberGoogleSignIn(testEnv(), testAuth());
		const claude = scriptedClaude([message([text("Ok.")], "end_turn")]);
		await handleAskRoute(askRequest({ text: "hi" }), askEnv(), ctx, claude);
		const tool = claude.requests[0]?.tools?.find(
			(candidate) => "name" in candidate && candidate.name === "jarvis_delete_event",
		);
		const description = tool && "description" in tool ? (tool.description ?? "") : "";
		expect(description).toContain("turned off confirmations");
		expect(description).not.toContain("wait for the user to confirm");
		expect(resolveDescription(deleteEventTool)).toContain("wait for the user to confirm");
	});

	it("doesn't offer the ping health check", async () => {
		mockGoogleRefresh();
		await rememberGoogleSignIn(testEnv(), testAuth());
		const claude = scriptedClaude([message([text("Ok.")], "end_turn")]);
		await handleAskRoute(askRequest({ text: "hi" }), askEnv(), ctx, claude);
		const names =
			claude.requests[0]?.tools?.map((tool) => ("name" in tool ? tool.name : "")) ?? [];
		expect(names).not.toContain("ping");
	});

	it("doesn't save a sign-in for another Google account", async () => {
		await rememberGoogleSignIn(testEnv(), testAuth({ email: "someone-else@example.com" }));
		expect(await env.OAUTH_KV.get("jarvis:ask:google-signin")).toBeNull();
	});
});

describe("runAsk", () => {
	const echoTool = defineTool({
		name: "echo",
		description: "Repeat a word.",
		inputSchema: z.object({ word: z.string() }),
		handler: async ({ word }) => speak(word),
	});

	it("returns invalid tool input to Claude as an error instead of running the tool", async () => {
		const claude = scriptedClaude([
			message([toolUse("t1", "echo", { word: 42 })], "tool_use"),
			message([text("Sorry.")], "end_turn"),
		]);
		const answer = await runAsk({
			question: "echo",
			history: [],
			context: testContext(),
			createMessage: claude.createMessage,
			tools: [echoTool],
		});
		expect(answer).toBe("Sorry.");
		const result = claude.requests[1]?.messages[2]?.content;
		expect(result).toMatchObject([{ type: "tool_result", tool_use_id: "t1", is_error: true }]);
	});

	it("speaks a short reply when Claude refuses, fails or loops", async () => {
		const run = (createMessage: CreateMessage) =>
			runAsk({
				question: "q",
				history: [],
				context: testContext(),
				createMessage,
				tools: [echoTool],
			});

		expect(await run(scriptedClaude([message([], "refusal")]).createMessage)).toBe(
			ASK_REPLIES.refused,
		);
		expect(await run(async () => Promise.reject(new TypeError("network")))).toBe(
			ASK_REPLIES.unreachable,
		);
		const looping: CreateMessage = async () =>
			message([toolUse("t", "echo", { word: "again" })], "tool_use");
		expect(await run(looping)).toBe(ASK_REPLIES.tooManySteps);
	});
});

describe("toSpeech", () => {
	it("strips formatting and links and caps the length at a sentence", () => {
		expect(toSpeech("# Today\n- **Lunch** at `1 PM`")).toBe("Today - Lunch at 1 PM");
		const long = toSpeech(`${"This is a sentence. ".repeat(50)}`);
		expect(long.length).toBeLessThanOrEqual(300);
		expect(long.endsWith(".")).toBe(true);
	});
});
