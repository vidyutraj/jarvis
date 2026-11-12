import Anthropic from "@anthropic-ai/sdk";
import type {
	BetaMessage,
	BetaMessageParam,
	BetaTool,
	BetaToolResultBlockParam,
	BetaToolUseBlock,
	MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { localParts } from "../lib/dates";
import { tools as allTools, type ToolContext } from "../tools";
import { DELETE_CONFIRM_RULE } from "../tools/delete-event";
import type { Tool } from "../tools/types";

/** One model request; injected so tests never call the real API. */
export type CreateMessage = (params: MessageCreateParamsNonStreaming) => Promise<BetaMessage>;

/** A finished spoken exchange, kept briefly so "yes, delete it" can follow a question. */
export interface Exchange {
	question: string;
	answer: string;
}

export const DEFAULT_ASK_MODEL = "claude-haiku-5-5";
/** Models with a server-side refusal fallback; Haiku has none, so the beta isn't sent for it. */
const FALLBACK_MODEL_PREFIXES = ["claude-opus-", "claude-sonnet-", "claude-fable-"];
/**
 * Quick spoken commands don't need thinking, and skipping it saves about a second.
 * Haiku accepts thinking off at low effort; Opus 5.5 and Sonnet 5.5 reject it, so
 * other models keep adaptive thinking.
 */
const NO_THINKING_MODEL_PREFIXES = ["claude-haiku-"];
/** "Hey Jarvis" doesn't need the connector health check, and fewer tools means a smaller request. */
const ASK_TOOLS = allTools.filter((tool) => tool.name !== "ping");
/** Model calls per question: enough to look something up and then act on it. */
const MAX_ROUNDS = 6;
const MAX_OUTPUT_TOKENS = 1024;
const REQUEST_TIMEOUT_MS = 25_000;
const MAX_SPOKEN_CHARS = 300;

export const ASK_REPLIES = {
	tooManySteps: "That took more steps than I allow. Try asking in a simpler way.",
	refused: "I can't help with that one.",
	unreachable: "I couldn't reach Claude just now. Try again in a moment.",
	busy: "Claude is busy right now. Try again in a minute.",
	badKey: "Jarvis's Claude API key isn't working. Check the ANTHROPIC_API_KEY secret.",
	empty: "Sorry, I don't have an answer for that.",
} as const;

/** The real Claude API, with a timeout and one retry so a spoken reply never hangs. */
export function anthropicCreateMessage(apiKey: string): CreateMessage {
	const client = new Anthropic({ apiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: 1 });
	return (params) => client.beta.messages.create(params);
}

function systemPrompt(context: ToolContext, now: Date): string {
	const { date, time } = localParts(now, context.env.TIME_ZONE);
	return `You are Jarvis, the owner's personal assistant. They said "Hey Jarvis" to their iPhone, and the phone reads your reply aloud. It is ${date} ${time} in ${context.env.TIME_ZONE}.

Personality: calm, sharp and quietly witty, like a seasoned butler who is also a friend. Dry understatement over enthusiasm. A light quip now and then is welcome, but never at the cost of being quick.

How you talk:
- Usually one short sentence, under 20 words. Two only when the answer truly needs it.
- Lead with the answer. Don't restate the question, don't narrate what you did, and don't offer more help at the end.
- No assistant filler: never "Certainly", "Of course", "Great question", "I'd be happy to", "Let me know if", "It looks like".
- Talk like a person: "dentist at 3, gym at 6", "about 240 dollars on food this month". Round numbers unless exact matters. Summarise lists to the few things that matter.
- Plain words only: no markdown, lists, links, IDs or emoji.

Examples:
- "What's on tomorrow?" → "Dentist at 10, then you're free until dinner with Sam at 7."
- "How much did I spend on food this month?" → "About 240 dollars, mostly takeout. The kitchen misses you."
- "Add gym Thursday at 6pm" → "Done, gym Thursday at 6."

Rules:
- Use your tools to answer or act: calendar, notes, bank accounts and spending. Act directly when the request is clear.
- Don't ask for permission: when the request is clear, do it and say what you did, e.g. "Deleted dentist Friday at 3." Only ask a question when it's genuinely ambiguous which item they mean.
- If a tool fails, say so briefly in plain words. Never invent results.
- You can't send email or messages for the owner, apart from what a tool itself does.
- When you use a tool, you may say a brief sentence first. If no tool can do what was asked, say so instead of guessing. Do not include internal or system XML tags in your reply.`;
}

const schemaCache = new WeakMap<Tool, BetaTool.InputSchema>();

/** JSON Schema for a tool's arguments, from the same zod schema the MCP server uses. */
function inputSchema(tool: Tool): BetaTool.InputSchema {
	let schema = schemaCache.get(tool);
	if (!schema) {
		const { $schema: _ignored, ...rest } = z.toJSONSchema(tool.inputSchema, { io: "input" });
		schema = { ...rest, type: "object" } as BetaTool.InputSchema;
		schemaCache.set(tool, schema);
	}
	return schema;
}

/**
 * The owner turned delete confirmations off for "Hey Jarvis" (a Shortcut can't
 * easily wait for a yes). Jarvis still asks when more than one event could match.
 */
const ASK_DELETE_RULE =
	"The owner has turned off confirmations for voice commands: if exactly one event clearly matches, delete it right away and say what you deleted. If more than one could match, ask which one instead of deleting.";

function toolDefinitions(tools: Tool[], context: ToolContext): BetaTool[] {
	return tools.map((tool) => {
		const description =
			typeof tool.description === "function" ? tool.description(context) : tool.description;
		return {
			name: tool.name,
			description: description.replace(DELETE_CONFIRM_RULE, ASK_DELETE_RULE),
			input_schema: inputSchema(tool),
		};
	});
}

function resultText(result: CallToolResult): string {
	const text = result.content
		.map((block) => (block.type === "text" ? block.text : ""))
		.filter(Boolean)
		.join("\n");
	return text || "Done.";
}

async function runTool(
	tools: Tool[],
	call: BetaToolUseBlock,
	context: ToolContext,
): Promise<BetaToolResultBlockParam> {
	const failed = (content: string): BetaToolResultBlockParam => ({
		type: "tool_result",
		tool_use_id: call.id,
		content,
		is_error: true,
	});
	const tool = tools.find((candidate) => candidate.name === call.name);
	if (!tool) return failed(`There is no tool called ${call.name}.`);

	const parsed = tool.inputSchema.safeParse(call.input);
	if (!parsed.success) return failed(`Invalid input: ${z.prettifyError(parsed.error)}`);

	try {
		const result = await tool.handler(parsed.data, context);
		return {
			type: "tool_result",
			tool_use_id: call.id,
			content: resultText(result),
			...(result.isError ? { is_error: true } : {}),
		};
	} catch (error) {
		// Tools shouldn't throw; if one does, log its name only (never inputs or tokens).
		const name = error instanceof Error ? error.name : "UnknownError";
		console.error(`Tool ${call.name} threw during /ask (${name}).`);
		return failed("The tool failed unexpectedly.");
	}
}

/** Keeps replies speakable even if the model slips into formatting. */
export function toSpeech(text: string): string {
	const plain = text
		.replace(/https?:\/\/\S+/g, "")
		.replace(/[*_#`>|]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (plain.length <= MAX_SPOKEN_CHARS) return plain;
	const cut = plain.slice(0, MAX_SPOKEN_CHARS);
	const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
	return lastStop > 0 ? cut.slice(0, lastStop + 1) : `${cut.trimEnd()}…`;
}

function apiFailureReply(error: unknown): string {
	if (
		error instanceof Anthropic.AuthenticationError ||
		error instanceof Anthropic.PermissionDeniedError
	)
		return ASK_REPLIES.badKey;
	if (error instanceof Anthropic.RateLimitError) return ASK_REPLIES.busy;
	if (error instanceof Anthropic.APIError && typeof error.status === "number")
		return error.status >= 500 ? ASK_REPLIES.busy : ASK_REPLIES.unreachable;
	return ASK_REPLIES.unreachable;
}

/**
 * Answers one spoken question: Claude plans, Jarvis's own tools run in-process
 * with the owner's identity, and the loop ends with a short spoken reply.
 */
export async function runAsk(options: {
	question: string;
	history: Exchange[];
	context: ToolContext;
	createMessage: CreateMessage;
	model?: string;
	tools?: Tool[];
	now?: Date;
}): Promise<string> {
	const { question, history, context, createMessage } = options;
	const tools = options.tools ?? ASK_TOOLS;
	const model = options.model || DEFAULT_ASK_MODEL;
	const withFallback = FALLBACK_MODEL_PREFIXES.some((prefix) => model.startsWith(prefix));
	const thinkingOff = NO_THINKING_MODEL_PREFIXES.some((prefix) => model.startsWith(prefix));
	const now = options.now ?? new Date();

	const messages: BetaMessageParam[] = [];
	for (const exchange of history) {
		messages.push({ role: "user", content: exchange.question });
		messages.push({ role: "assistant", content: exchange.answer });
	}
	messages.push({ role: "user", content: question });

	const definitions = toolDefinitions(tools, context);
	const system = systemPrompt(context, now);

	// One log line per question: timing and token counts only, never what was said.
	const startedAt = Date.now();
	const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
	let rounds = 0;
	const finish = (reply: string, outcome: string): string => {
		console.log(
			`/ask ${outcome}: ${Date.now() - startedAt} ms, ${rounds} round(s), ${model}, tokens in ${usage.input} ` +
				`(cache read ${usage.cacheRead}, cache write ${usage.cacheWrite}), out ${usage.output}`,
		);
		return reply;
	};

	while (rounds < MAX_ROUNDS) {
		rounds++;
		let response: BetaMessage;
		try {
			response = await createMessage({
				model,
				max_tokens: MAX_OUTPUT_TOKENS,
				system,
				tools: definitions,
				messages,
				// Spoken Q&A: keep it quick.
				output_config: { effort: "low" },
				...(thinkingOff ? { thinking: { type: "disabled" as const } } : {}),
				// Caches the tool definitions and earlier turns between rounds of the loop.
				cache_control: { type: "ephemeral" },
				// If the model declines for safety reasons, the API retries on a fallback model.
				...(withFallback
					? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
					: {}),
			});
		} catch (error) {
			const status = error instanceof Anthropic.APIError ? String(error.status) : "none";
			const name = error instanceof Error ? error.name : "UnknownError";
			console.error(`Claude API call for /ask failed (${name}, status ${status}).`);
			return finish(apiFailureReply(error), "api error");
		}
		usage.input += response.usage.input_tokens;
		usage.cacheRead += response.usage.cache_read_input_tokens ?? 0;
		usage.cacheWrite += response.usage.cache_creation_input_tokens ?? 0;
		usage.output += response.usage.output_tokens;

		if (response.stop_reason === "refusal") return finish(ASK_REPLIES.refused, "refused");

		// Keep the whole response (thinking blocks included) so the next round continues correctly.
		messages.push({ role: "assistant", content: response.content });
		const calls = response.content.filter(
			(block): block is BetaToolUseBlock => block.type === "tool_use",
		);

		if (response.stop_reason === "tool_use" && calls.length > 0) {
			const results = await Promise.all(calls.map((call) => runTool(tools, call, context)));
			messages.push({ role: "user", content: results });
			continue;
		}

		const text = response.content
			.map((block) => (block.type === "text" ? block.text : ""))
			.join(" ");
		return finish(toSpeech(text) || ASK_REPLIES.empty, "answered");
	}
	return finish(ASK_REPLIES.tooManySteps, "too many steps");
}
