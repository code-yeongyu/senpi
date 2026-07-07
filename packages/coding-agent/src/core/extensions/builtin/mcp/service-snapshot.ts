import type { ResolvedMcpServer } from "./config-schema.ts";
import type { ServerConnection } from "./connection.ts";
import type { McpConnectionEntry, McpServerSnapshot } from "./service-types.ts";

export function buildMcpServerSnapshot(
	name: string,
	server: ResolvedMcpServer | undefined,
	connection: ServerConnection | undefined,
	entry: McpConnectionEntry | undefined,
	now = Date.now(),
): McpServerSnapshot {
	return {
		name,
		configState: server?.state ?? "removed",
		configHash: server?.configHash ?? null,
		sourcePath: server?.sourcePath ?? null,
		lifecycleState:
			connection?.state === "idle" && connection.generation === 0 && entry?.cachedCatalog !== undefined
				? "cached"
				: (connection?.state ?? "not_spawned"),
		generation: connection?.generation ?? null,
		pid: connection?.getRootPid() ?? null,
		lastError: connection?.lastError?.message ?? null,
		uptimeMs: entry === undefined ? null : now - entry.createdAtMs,
		counters: entry?.counters ?? { callCount: 0, errorCount: 0, totalLatencyMs: 0, reconnectCount: 0 },
	};
}
