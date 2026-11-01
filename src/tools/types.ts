import type { CallToolResult, McpServer, ToolAnnotations } from "@modelcontextprotocol/server";
import type { z } from "zod";
import type { AuthProps } from "../auth/props";

/** What every tool handler receives besides its arguments. */
export interface ToolContext {
	env: Env;
	/** The signed-in user and their Google tokens (encrypted at rest by the OAuth library). */
	auth: AuthProps;
}

/** The house shape for a tool: one per file in src/tools/, listed in src/tools/index.ts. */
export interface ToolDefinition<Schema extends z.ZodObject> {
	/** snake_case name Claude sees. */
	name: string;
	/**
	 * Tells Claude exactly when to use the tool and how to prepare its input.
	 * A function is evaluated per request, e.g. to include today's date.
	 */
	description: string | ((context: ToolContext) => string);
	/** Hints for clients, e.g. { readOnlyHint: true } for tools that only read. */
	annotations?: ToolAnnotations;
	inputSchema: Schema;
	/** Must resolve to a short, speakable result (see lib/respond.ts). Should not throw. */
	handler: (args: z.output<Schema>, context: ToolContext) => Promise<CallToolResult>;
}

export interface Tool<Schema extends z.ZodObject = z.ZodObject> extends ToolDefinition<Schema> {
	register: (server: McpServer, context: ToolContext) => void;
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
		register(server, context) {
			// The SDK's callback type is conditional on the schema type, which TypeScript
			// can't resolve for a generic, so register against the widened schema. The SDK
			// validates args against this same schema before calling us, making the cast safe.
			const inputSchema: z.ZodObject = definition.inputSchema;
			server.registerTool(
				definition.name,
				{
					description:
						typeof definition.description === "function"
							? definition.description(context)
							: definition.description,
					inputSchema,
					...(definition.annotations ? { annotations: definition.annotations } : {}),
				},
				(args) => definition.handler(args as z.output<Schema>, context),
			);
		},
	};
}
