import { z } from "zod";
import { speak } from "../lib/respond";
import { defineTool } from "./types";

export const pingTool = defineTool({
	name: "ping",
	description:
		"Check that the Jarvis server is reachable. Use only when the user asks whether the server, connection or Jarvis is working.",
	inputSchema: z.object({}),
	handler: async () => speak("Pong! Your server is live."),
});
