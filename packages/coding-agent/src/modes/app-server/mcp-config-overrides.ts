import { APP_SERVER_MCP_CONFIG_SOURCE_PATH } from "../../core/extensions/builtin/mcp/additional-config.ts";
import type { McpServerDeclaration } from "../../core/extensions/builtin/mcp/config-schema.ts";
import { createMcpLogger } from "../../core/extensions/builtin/mcp/log.ts";
import type { InlineExtension } from "../../core/extensions/types.ts";

export const APP_SERVER_MCP_CONFIG_SOURCE_NAME = APP_SERVER_MCP_CONFIG_SOURCE_PATH.slice("<inline:".length, -1);

export type AppServerConfigOverride = { readonly key: string; readonly value: string };

export type AppServerMcpConfigSource = {
	readonly servers: Readonly<Record<string, McpServerDeclaration>>;
	readonly diagnostics: readonly string[];
	readonly extensionFactories: readonly InlineExtension[];
};

type PendingServer = {
	url?: string;
	bearerTokenEnv?: string;
};

const MCP_OVERRIDE_PATTERN = /^mcp_servers\.([A-Za-z0-9._-]+)\.(url|bearer_token_env_var)$/u;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export function materializeAppServerMcpConfigSource(
	overrides: readonly AppServerConfigOverride[],
): AppServerMcpConfigSource {
	const pending = new Map<string, PendingServer>();
	let malformed = false;
	let unsupported = false;
	for (const override of overrides) {
		const match = MCP_OVERRIDE_PATTERN.exec(override.key);
		if (match === null) {
			if (override.key.startsWith("mcp_servers.")) malformed = true;
			else unsupported = true;
			continue;
		}
		const name = match[1];
		const field = match[2];
		if (name === undefined || field === undefined) {
			malformed = true;
			continue;
		}
		const server = pending.get(name) ?? {};
		if (field === "url") server.url = override.value;
		else server.bearerTokenEnv = stripSurroundingDoubleQuotes(override.value);
		pending.set(name, server);
	}

	const servers: Record<string, McpServerDeclaration> = {};
	let incomplete = false;
	for (const [name, server] of pending) {
		if (server.url === undefined || server.bearerTokenEnv === undefined) {
			incomplete = true;
			continue;
		}
		if (!isHttpUrl(server.url) || !ENV_NAME_PATTERN.test(server.bearerTokenEnv)) {
			malformed = true;
			continue;
		}
		servers[name] = Object.freeze({
			type: "http",
			url: server.url,
			auth: "bearer",
			bearerTokenEnv: server.bearerTokenEnv,
		});
	}
	Object.freeze(servers);

	const diagnostics = Object.freeze([
		...(incomplete ? ["ignored incomplete app-server MCP config override"] : []),
		...(malformed ? ["ignored malformed app-server MCP config override"] : []),
		...(unsupported ? ["ignored unsupported app-server config override"] : []),
	]);
	const extensionFactories: readonly InlineExtension[] =
		Object.keys(servers).length === 0 && diagnostics.length === 0
			? []
			: [
					{
						name: APP_SERVER_MCP_CONFIG_SOURCE_NAME,
						hidden: true,
						factory: (pi) => {
							const logger = createMcpLogger(APP_SERVER_MCP_CONFIG_SOURCE_NAME);
							for (const diagnostic of diagnostics) logger.debug(diagnostic, { value: "<redacted>" });
							for (const [name, config] of Object.entries(servers)) pi.registerMcpServer(name, config);
						},
					},
				];
	return Object.freeze({ servers, diagnostics, extensionFactories: Object.freeze(extensionFactories) });
}

function stripSurroundingDoubleQuotes(value: string): string {
	return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

function isHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "";
	} catch (error: unknown) {
		if (error instanceof TypeError) return false;
		throw error;
	}
}
