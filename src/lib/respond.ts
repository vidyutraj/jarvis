import type { CallToolResult } from "@modelcontextprotocol/server";

/**
 * Every tool result is read aloud by Claude's voice mode, so replies are plain
 * text of one or two short sentences. These helpers keep that shape consistent.
 */
export function speak(text: string): CallToolResult {
	return { content: [{ type: "text", text }] };
}

/** Same as `speak`, but flags the result as a failure so Claude knows the action didn't happen. */
export function speakError(text: string): CallToolResult {
	return { content: [{ type: "text", text }], isError: true };
}
