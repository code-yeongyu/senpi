import type { RegisteredMcpServerDeclaration } from "../../types.ts";
import { resolveExtensionMcpServer } from "./config.ts";
import type { ResolvedMcpConfig } from "./config-schema.ts";

export const APP_SERVER_MCP_CONFIG_SOURCE_PATH = "<inline:app-server-config-overrides>";

/** Merge process-local declarations after persisted and ordinary extension sources. */
export function mergeAdditionalMcpServers(
	result: ResolvedMcpConfig,
	declarations: readonly RegisteredMcpServerDeclaration[],
): void {
	for (const declaration of declarations) {
		const existing = result.servers[declaration.name];
		if (existing !== undefined) {
			result.diagnostics.push(
				`Process-local MCP server '${declaration.name}' replaces ${existing.source} config at ${existing.sourcePath}.`,
			);
		}
		result.servers[declaration.name] = resolveExtensionMcpServer(
			declaration.name,
			declaration.config,
			declaration.extensionPath,
			declaration.registrationCwd,
		);
	}
}
