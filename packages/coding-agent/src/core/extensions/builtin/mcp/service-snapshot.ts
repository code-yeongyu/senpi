import { redactResolvedReferenceValues } from "../../../config-reference-redaction.ts";
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
		configHash: entry?.generationHash ?? server?.configHash ?? null,
		source: server?.source ?? null,
		sourcePath: server?.sourcePath ?? null,
		lifecycleState:
			connection?.state === "idle" && connection.generation === 0 && entry?.cachedCatalog !== undefined
				? "cached"
				: (connection?.state ?? "not_spawned"),
		generation: connection?.generation ?? null,
		pid: connection?.getRootPid() ?? null,
		lastError:
			connection?.lastError === undefined ? null : redactResolvedReferenceValues(connection.lastError.message),
		uptimeMs: entry === undefined ? null : now - entry.createdAtMs,
		counters: entry?.counters ?? { callCount: 0, errorCount: 0, totalLatencyMs: 0, reconnectCount: 0 },
	};
}
