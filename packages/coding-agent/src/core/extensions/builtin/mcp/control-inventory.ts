import type { EventBus } from "../../../event-bus.ts";
import type { McpWireStatusSnapshot } from "./service-types.ts";
import { safeEventBusOn } from "./wrap.ts";

export const MCP_CONTROL_INVENTORY_REQUEST_EVENT = "senpi.rpc.mcp_inventory.request";
export const MCP_CONTROL_INVENTORY_CHANGED_EVENT = "senpi.rpc.mcp_inventory.changed";

export interface McpControlInventoryRequest {
	readonly sessionId: string;
	respond(snapshot: Promise<McpWireStatusSnapshot>): void;
}

export interface McpControlInventoryChanged {
	readonly sessionId: string;
	readonly snapshot: McpWireStatusSnapshot;
	/** Set on the one notification sent once every MCP connect of the session's attach has settled (senpi#4828). */
	readonly startupSettled?: true;
}

export function isMcpControlInventoryRequest(value: unknown): value is McpControlInventoryRequest {
	return (
		typeof value === "object" &&
		value !== null &&
		"sessionId" in value &&
		typeof value.sessionId === "string" &&
		"respond" in value &&
		typeof value.respond === "function"
	);
}

export function isMcpControlInventoryChanged(value: unknown): value is McpControlInventoryChanged {
	return (
		typeof value === "object" &&
		value !== null &&
		"sessionId" in value &&
		typeof value.sessionId === "string" &&
		"snapshot" in value &&
		isMcpWireStatusSnapshot(value.snapshot)
	);
}

function isMcpWireStatusSnapshot(value: unknown): value is McpWireStatusSnapshot {
	return typeof value === "object" && value !== null && "servers" in value && Array.isArray(value.servers);
}

interface McpControlInventorySource {
	refreshWireStatusSnapshot(sessionId?: string): Promise<McpWireStatusSnapshot>;
	onWireStatusChanged(
		listener: (sessionId: string | undefined, snapshot: McpWireStatusSnapshot, startupSettled: boolean) => void,
	): () => void;
}

/**
 * Answer control-inventory requests and forward wire-status changes for every session in `attached` (each scope a
 * runtime attached). The returned function stops both and is safe to call more than once.
 */
export function forwardMcpControlInventory(
	events: EventBus,
	service: McpControlInventorySource,
	attached: ReadonlySet<string>,
): () => void {
	let disposed = false;
	const unsubscribeRequest = safeEventBusOn(events, MCP_CONTROL_INVENTORY_REQUEST_EVENT, (data) => {
		if (!isMcpControlInventoryRequest(data) || !attached.has(data.sessionId)) return;
		data.respond(service.refreshWireStatusSnapshot(data.sessionId));
	});
	const unsubscribeWireStatus = service.onWireStatusChanged((sessionId, snapshot, startupSettled) => {
		if (sessionId === undefined || !attached.has(sessionId)) return;
		events.emit(
			MCP_CONTROL_INVENTORY_CHANGED_EVENT,
			startupSettled ? { sessionId, snapshot, startupSettled: true } : { sessionId, snapshot },
		);
	});
	return () => {
		if (disposed) return;
		disposed = true;
		unsubscribeRequest();
		unsubscribeWireStatus();
	};
}
