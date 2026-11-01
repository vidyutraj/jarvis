import { describe, expect, it } from "vitest";
import { pingTool } from "../src/tools/ping";
import { expectSpeakable, resultText, testEnv } from "./helpers";

describe("ping", () => {
	it("replies that the server is live", async () => {
		const result = await pingTool.handler({}, testEnv());

		expect(resultText(result)).toBe("Pong! Your server is live.");
		expect(result.isError).toBeUndefined();
		expectSpeakable(result);
	});
});
