import { decryptSecret, encryptSecret } from "../lib/secret-box";
import { anthropicCreateMessage, runAsk, type CreateMessage, type Exchange } from "./agent";
import { loadAskAuth, rememberGoogleSignIn } from "./google-signin";

/**
 * POST /ask: the "Hey Jarvis" endpoint for an iPhone Shortcut.
 *   Authorization: Bearer <JARVIS_ASK_KEY>
 *   Body: {"text": "what's on my calendar tomorrow?"}
 *   Reply: plain text for the Shortcut's "Speak Text" step.
 *
 * Sits outside the OAuth layer (a Shortcut can't do OAuth) but is not open:
 * every request needs the long random key, compared in constant time, and the
 * route is rate limited before the key is checked. What was said is never logged.
 */
export const ASK_PATH = "/ask";

const MIN_KEY_LENGTH = 32;
const MAX_BODY_BYTES = 8_192;
const MAX_QUESTION_CHARS = 1_000;
/** Follow-ups ("yes, delete it") within this window see the last few exchanges. */
const HISTORY_TTL_SECONDS = 600;
const HISTORY_EXCHANGES = 5;
const HISTORY_KV_KEY = "jarvis:ask:history";

export const ASK_ROUTE_REPLIES = {
	notSetUp: "Hey Jarvis isn't set up yet on the server.",
	unauthorized: "Not authorized.",
	tooFast: "You're asking too quickly. Wait a minute and try again.",
	badRequest: "I didn't catch that. Try again.",
	needsSignIn:
		"Jarvis needs a one-time Google sign-in first. Reconnect Jarvis in Claude's settings, then try again.",
} as const;

export interface AskRouteDeps {
	createMessage?: CreateMessage;
}

function speech(text: string, status = 200): Response {
	return new Response(text, {
		status,
		headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
	});
}

/** Constant-time key check: hash both sides so lengths always match. */
async function keyMatches(given: string, expected: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const [a, b] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(given)),
		crypto.subtle.digest("SHA-256", encoder.encode(expected)),
	]);
	return crypto.subtle.timingSafeEqual(a, b);
}

async function readQuestion(request: Request): Promise<string | null> {
	const declared = Number(request.headers.get("Content-Length") ?? "0");
	if (declared > MAX_BODY_BYTES) return null;
	const raw = await request.text();
	if (raw.length > MAX_BODY_BYTES) return null;
	let body: unknown;
	try {
		body = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof body !== "object" || body === null) return null;
	const text = (body as Record<string, unknown>).text;
	if (typeof text !== "string") return null;
	const question = text.trim().slice(0, MAX_QUESTION_CHARS);
	return question || null;
}

async function loadHistory(env: Env): Promise<Exchange[]> {
	try {
		const sealed = await env.OAUTH_KV.get(HISTORY_KV_KEY);
		if (!sealed) return [];
		const plain = await decryptSecret(env.JARVIS_SECRET_KEY, "ask-history", sealed);
		const parsed: unknown = plain ? JSON.parse(plain) : [];
		return Array.isArray(parsed) ? (parsed as Exchange[]) : [];
	} catch {
		return [];
	}
}

async function saveHistory(env: Env, history: Exchange[]): Promise<void> {
	try {
		const sealed = await encryptSecret(
			env.JARVIS_SECRET_KEY,
			"ask-history",
			JSON.stringify(history.slice(-HISTORY_EXCHANGES)),
		);
		await env.OAUTH_KV.put(HISTORY_KV_KEY, sealed, { expirationTtl: HISTORY_TTL_SECONDS });
	} catch {
		// Follow-up memory is a convenience; the answer was already given.
	}
}

/** Handles /ask, or returns null for any other path. */
export async function handleAskRoute(
	request: Request,
	env: Env,
	ctx: Pick<ExecutionContext, "waitUntil">,
	deps: AskRouteDeps = {},
): Promise<Response | null> {
	if (new URL(request.url).pathname !== ASK_PATH) return null;
	if (request.method !== "POST") {
		return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
	}

	const { success } = await env.ASK_LIMITER.limit({ key: ASK_PATH });
	if (!success) return speech(ASK_ROUTE_REPLIES.tooFast, 429);

	const expected = env.JARVIS_ASK_KEY?.trim() ?? "";
	if (expected.length < MIN_KEY_LENGTH || !env.ANTHROPIC_API_KEY?.trim()) {
		return speech(ASK_ROUTE_REPLIES.notSetUp, 503);
	}
	const header = request.headers.get("Authorization") ?? "";
	const given = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
	if (!given || !(await keyMatches(given, expected))) {
		return speech(ASK_ROUTE_REPLIES.unauthorized, 401);
	}

	const question = await readQuestion(request);
	if (!question) return speech(ASK_ROUTE_REPLIES.badRequest, 400);

	const [signIn, history] = await Promise.all([loadAskAuth(env), loadHistory(env)]);
	if (!signIn.ok) return speech(ASK_ROUTE_REPLIES.needsSignIn);
	// Bookkeeping happens after the reply is sent, so it never slows the answer.
	if (signIn.refreshed) ctx.waitUntil(rememberGoogleSignIn(env, signIn.auth));

	const answer = await runAsk({
		question,
		history,
		context: { env, auth: signIn.auth },
		createMessage: deps.createMessage ?? anthropicCreateMessage(env.ANTHROPIC_API_KEY),
		model: env.ASK_MODEL,
	});
	ctx.waitUntil(saveHistory(env, [...history, { question, answer }]));
	return speech(answer);
}
