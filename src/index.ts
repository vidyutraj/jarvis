import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { env as workerEnv } from "cloudflare:workers";
import { isAllowedEmail } from "./auth/allowlist";
import { googleAuthHandler } from "./auth/google-handler";
import { isAuthProps } from "./auth/props";
import { handleTokenExchange } from "./auth/token-exchange";
import { sitePage } from "./site";
import { tools, type ToolContext } from "./tools";

const SECONDS_PER_DAY = 86_400;

export function createServer(context: ToolContext): McpServer {
	const server = new McpServer({ name: "Jarvis", version: "0.2.0" });
	for (const tool of tools) {
		tool.register(server, context);
	}
	return server;
}

/** Reached only with a valid access token; the OAuth library rejects everything else with a 401. */
const mcpApiHandler = {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const auth: unknown = ctx.props;
		// Defense in depth: sign-in already enforces the allowlist, but check every request too.
		if (!isAuthProps(auth) || !isAllowedEmail(auth.email, env.ALLOWED_EMAIL)) {
			return new Response("Forbidden", { status: 403 });
		}
		// The stateless handler's factory receives no bindings, so build it per request
		// to hand this request's env and signed-in user to the tools.
		const handler = createMcpHandler(() => createServer({ env, auth }));
		return handler(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;

/** Public pages (home, privacy policy) first; everything else is the sign-in flow. */
const defaultHandler = {
	fetch(request: Request, env: Env) {
		const page = request.method === "GET" ? sitePage(new URL(request.url).pathname) : null;
		return page ?? googleAuthHandler.fetch(request, env);
	},
} satisfies ExportedHandler<Env>;

export default new OAuthProvider<Env>({
	apiRoute: "/mcp",
	apiHandler: mcpApiHandler,
	defaultHandler,
	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/token",
	// Dynamic client registration: Claude registers itself, so no client ID/secret in the connector.
	clientRegistrationEndpoint: "/register",
	// Must equal the connector URL exactly. Changing it invalidates every grant.
	resourceMetadata: { resource: workerEnv.MCP_RESOURCE },
	// Stay signed in while Jarvis is used at least every 90 days, instead of a fixed 30-day login.
	refreshTokenIdleTTL: 90 * SECONDS_PER_DAY,
	tokenExchangeCallback: handleTokenExchange,
});
