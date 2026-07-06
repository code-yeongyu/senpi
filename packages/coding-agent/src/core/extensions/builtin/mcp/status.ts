import type { McpServerExposureStatus } from "./expose/status.ts";
import type { McpServerSnapshot } from "./service.ts";

export interface McpStatusRow {
	readonly exposure: McpServerExposureStatus;
	readonly snapshot: McpServerSnapshot;
}

export async function buildMcpStatusRows(
	snapshots: readonly McpServerSnapshot[],
	getExposureStatus: (name: string) => Promise<McpServerExposureStatus>,
): Promise<McpStatusRow[]> {
	return Promise.all(
		snapshots.map(async (snapshot) => ({
			exposure: await getExposureStatus(snapshot.name),
			snapshot,
		})),
	);
}

export function formatMcpStatus(title: string, rows: readonly McpStatusRow[]): string {
	return [title, ...rows.map(formatRow)].join("\n");
}

function formatRow(row: McpStatusRow): string {
	const snapshot = row.snapshot;
	const averageLatencyMs =
		snapshot.counters.callCount === 0
			? 0
			: Math.round(snapshot.counters.totalLatencyMs / snapshot.counters.callCount);
	return [
		snapshot.name,
		snapshot.configState,
		`state=${snapshot.lifecycleState}`,
		`source=${snapshot.sourcePath ?? "n/a"}`,
		`tools=${row.exposure.toolCount ?? "?"}`,
		`uptime=${formatUptime(snapshot.uptimeMs)}`,
		`calls=${snapshot.counters.callCount}`,
		`errors=${snapshot.counters.errorCount}`,
		`latency=${averageLatencyMs}ms`,
		`reconnects=${snapshot.counters.reconnectCount}`,
		snapshot.lastError ? `lastError=${snapshot.lastError}` : "",
		row.exposure.hint ? `hint=${row.exposure.hint}` : "",
	]
		.filter((part) => part.length > 0)
		.join(" ");
}

function formatUptime(uptimeMs: number | null): string {
	if (uptimeMs === null) return "n/a";
	if (uptimeMs < 1000) return "<1s";
	return `${Math.round(uptimeMs / 1000)}s`;
}
