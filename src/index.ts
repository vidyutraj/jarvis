import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { tools } from "./tools";

export function createServer(env: Env): McpServer {
	const server = new McpServer({ name: "Jarvis", version: "0.1.0" });
	for (const tool of tools) {
		tool.register(server, env);
	}
	return server;
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		// The handler is stateless and its factory receives no bindings, so it is
		// built per request to hand this request's env to the tools.
		const handler = createMcpHandler(() => createServer(env));
		return handler(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
