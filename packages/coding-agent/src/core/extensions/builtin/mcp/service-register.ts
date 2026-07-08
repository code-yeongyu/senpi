import type { ExtensionAPI } from "../../types.ts";
import type { ResolvedMcpConfig } from "./config-schema.ts";
import type { McpSessionRegistration } from "./expose/session.ts";
import { registerDirectMcpTools } from "./expose/session.ts";
import type { McpConnectionEntry } from "./service-types.ts";
import { connectAndRefreshMcpCatalog } from "./startup-race.ts";

type McpToolRegistrar = Pick<ExtensionAPI, "getActiveTools" | "setActiveTools" | "registerTool">;

export interface McpServiceDirectToolRegistrationOptions {
	readonly refreshActiveSetWhenEmpty?: boolean;
}

export async function registerMcpServiceDirectTools(
	pi: McpToolRegistrar,
	config: ResolvedMcpConfig,
	entries: Iterable<McpConnectionEntry>,
	options: McpServiceDirectToolRegistrationOptions = {},
): Promise<McpSessionRegistration | undefined> {
	return await registerDirectMcpTools(
		pi,
		config,
		[...entries].map((entry) => {
			const serverConfig = config.servers[entry.name]?.config;
			return {
				agentDir: entry.agentDir,
				cachedCatalog: entry.cachedCatalog,
				connection: entry.connection,
				ensureFresh: () => entry.authPlan?.refresh?.ensureFresh().then(() => undefined) ?? Promise.resolve(),
				ensureCachedToolConnected: () => connectAndRefreshMcpCatalog(entry, serverConfig),
				logger: entry.logger,
				name: entry.name,
			};
		}),
		options,
	);
}
