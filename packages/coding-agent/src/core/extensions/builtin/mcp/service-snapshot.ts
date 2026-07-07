import type { ResolvedMcpServer } from "./config-schema.ts";
import type { ServerConnection } from "./connection.ts";
import { diagnoseCapturedMcpConnectFailure } from "./diagnose.ts";
import type { McpConnectionEntry, McpServerSnapshot } from "./service-types.ts";

export function buildMcpServerSnapshot(
	name: string,
	server: ResolvedMcpServer | undefined,
	connection: ServerConnection | undefined,
	entry: McpConnectionEntry | undefined,
	now = Date.now(),
): McpServerSnapshot {
	const lastError = resolveSnapshotLastError(name, server, connection, entry);
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
		lastError,
		uptimeMs: entry === undefined ? null : now - entry.createdAtMs,
		counters: entry?.counters ?? { callCount: 0, errorCount: 0, totalLatencyMs: 0, reconnectCount: 0 },
	};
}

function resolveSnapshotLastError(
	name: string,
	server: ResolvedMcpServer | undefined,
	connection: ServerConnection | undefined,
	entry: McpConnectionEntry | undefined,
): string | null {
	const error = connection?.lastError;
	if (error === undefined) return null;
	if (!isGenericTransportClose(error) || server?.config === undefined || entry === undefined) return error.message;
	return (
		diagnoseCapturedMcpConnectFailure({
			config: server.config,
			cause: error,
			logger: entry.logger,
			serverName: name,
		})?.message ?? error.message
	);
}

function isGenericTransportClose(error: Error): boolean {
	return error.message.includes("transport closed");
}
