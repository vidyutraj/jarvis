import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { NOTE_BODY_MAX_LENGTH, saveNoteTool } from "../src/tools/save-note";
import { expectSpeakable, resultText, testEnv } from "./helpers";

function telegramReply(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("save_note", () => {
	let fetchSpy: MockInstance<typeof fetch>;
	let errorSpy: MockInstance<typeof console.error>;

	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, "fetch");
		// Keep expected error logs out of the test output.
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sends the note to the configured chat and confirms", async () => {
		fetchSpy.mockResolvedValue(telegramReply({ ok: true, result: {} }));

		const result = await saveNoteTool.handler(
			{ title: "Grocery app", body: "Shared list for the house" },
			testEnv(),
		);

		expect(resultText(result)).toBe('Got it, I sent "Grocery app" to your Telegram.');
		expect(result.isError).toBeUndefined();
		expectSpeakable(result);

		expect(fetchSpy).toHaveBeenCalledOnce();
		const [url, init] = fetchSpy.mock.calls[0]!;
		expect(String(url)).toBe("https://api.telegram.org/bottest-bot-token/sendMessage");
		expect(init?.method).toBe("POST");
		expect(JSON.parse(String(init?.body))).toMatchObject({
			chat_id: "123456",
			parse_mode: "HTML",
			text: "<b>Grocery app</b>\n\nShared list for the house",
		});
	});

	it("escapes HTML so note text can't break Telegram formatting", async () => {
		fetchSpy.mockResolvedValue(telegramReply({ ok: true }));

		await saveNoteTool.handler({ title: "a < b & c", body: "<i>not italic</i>" }, testEnv());

		const sent = JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body));
		expect(sent.text).toBe("<b>a &lt; b &amp; c</b>\n\n&lt;i&gt;not italic&lt;/i&gt;");
	});

	it("says Telegram isn't set up when secrets are missing, without calling Telegram", async () => {
		const result = await saveNoteTool.handler(
			{ title: "Idea", body: "Something" },
			testEnv({ TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "" }),
		);

		expect(resultText(result)).toBe("Telegram isn't set up yet, so I couldn't save that note.");
		expect(result.isError).toBe(true);
		expect(fetchSpy).not.toHaveBeenCalled();
		expectSpeakable(result);
	});

	it("reports a rejection when Telegram returns an error", async () => {
		fetchSpy.mockResolvedValue(
			telegramReply({ ok: false, description: "Bad Request: chat not found" }, 400),
		);

		const result = await saveNoteTool.handler({ title: "Idea", body: "Something" }, testEnv());

		expect(resultText(result)).toBe("Telegram didn't accept that note, so it wasn't saved.");
		expect(result.isError).toBe(true);
		expectSpeakable(result);
	});

	it("treats a 200 response with ok:false as a rejection", async () => {
		fetchSpy.mockResolvedValue(telegramReply({ ok: false, description: "odd" }));

		const result = await saveNoteTool.handler({ title: "Idea", body: "Something" }, testEnv());

		expect(result.isError).toBe(true);
	});

	it("reports Telegram as unreachable on a network failure", async () => {
		fetchSpy.mockRejectedValue(new TypeError("Network connection lost"));

		const result = await saveNoteTool.handler({ title: "Idea", body: "Something" }, testEnv());

		expect(resultText(result)).toBe(
			"I couldn't reach Telegram just now. Try again in a moment.",
		);
		expect(result.isError).toBe(true);
		expectSpeakable(result);
	});

	it("never logs the bot token", async () => {
		fetchSpy.mockResolvedValue(telegramReply({ ok: false, description: "Unauthorized" }, 401));

		await saveNoteTool.handler({ title: "Idea", body: "Something" }, testEnv());

		expect(errorSpy).toHaveBeenCalled();
		const logged = errorSpy.mock.calls.flat().join(" ");
		expect(logged).not.toContain("test-bot-token");
	});

	it("rejects empty or oversized input at the schema", () => {
		const { inputSchema } = saveNoteTool;
		expect(inputSchema.safeParse({ title: "  ", body: "x" }).success).toBe(false);
		expect(
			inputSchema.safeParse({ title: "t", body: "x".repeat(NOTE_BODY_MAX_LENGTH + 1) })
				.success,
		).toBe(false);
		expect(inputSchema.safeParse({ title: " Idea ", body: " text " }).data).toEqual({
			title: "Idea",
			body: "text",
		});
	});
});
