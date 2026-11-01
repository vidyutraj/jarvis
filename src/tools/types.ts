import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import type { z } from "zod";

/** The house shape for a tool: one per file in src/tools/, listed in src/tools/index.ts. */
export interface ToolDefinition<Schema extends z.ZodObject> {
	/** snake_case name Claude sees. */
	name: string;
	/** Tells Claude exactly when to use the tool and how to prepare its input. */
	description: string;
	inputSchema: Schema;
	/** Must resolve to a short, speakable result (see lib/respond.ts). Should not throw. */
	handler: (args: z.output<Schema>, env: Env) => Promise<CallToolResult>;
}

export interface Tool<Schema extends z.ZodObject = z.ZodObject> extends ToolDefinition<Schema> {
	register: (server: McpServer, env: Env) => void;
}

/**
 * Wraps a definition with a `register` method. Keeping the generic inside this
 * closure lets tools with different schemas share one list in src/tools/index.ts.
 */
export function defineTool<Schema extends z.ZodObject>(
	definition: ToolDefinition<Schema>,
): Tool<Schema> {
	return {
		...definition,
		register(server, env) {
			// The SDK's callback type is conditional on the schema type, which TypeScript
			// can't resolve for a generic, so register against the widened schema. The SDK
			// validates args against this same schema before calling us, making the cast safe.
			const inputSchema: z.ZodObject = definition.inputSchema;
			server.registerTool(
				definition.name,
				{ description: definition.description, inputSchema },
				(args) => definition.handler(args as z.output<Schema>, env),
			);
		},
	};
}
