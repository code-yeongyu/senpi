/**
 * What a predecessor sends about a routed session is parsed here, not trusted structurally: a version-skewed
 * generation's row is relayed to clients and its park drives a local reopen (cwd, profile, retention).
 */
import { type HandoverParkedEntry, isHandoverParkedEntry } from "./host-handover-parked.ts";
import { authRecord } from "./rpc-auth-proof.ts";
import type { RpcSessionRow } from "./session-registry-types.ts";

const ROW_STATES: readonly unknown[] = ["opening", "open", "closing"];

export function isRoutedSessionRow(value: unknown): value is RpcSessionRow {
	const row = authRecord(value);
	return (
		row !== undefined &&
		typeof row.sessionId === "string" &&
		typeof row.cwd === "string" &&
		ROW_STATES.includes(row.status) &&
		typeof row.attachments === "number" &&
		typeof row.retain_on_disconnect === "boolean" &&
		typeof row.kind === "string" &&
		authRecord(row.context) !== undefined &&
		(row.sessionPath === undefined || typeof row.sessionPath === "string") &&
		(row.durableSessionId === undefined || typeof row.durableSessionId === "string")
	);
}

/** The routed attach's `routeRow` / `routePark`: each is kept only when it has the shape its reader needs. */
export function routedAttachExtras(data: Readonly<Record<string, unknown>>): {
	readonly row?: RpcSessionRow;
	readonly park?: HandoverParkedEntry;
} {
	const { routeRow, routePark } = data;
	return {
		...(isRoutedSessionRow(routeRow) ? { row: routeRow } : {}),
		...(isHandoverParkedEntry(routePark) ? { park: routePark } : {}),
	};
}
