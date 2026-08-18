import type { McpWireStatusSnapshot } from "./service-types.ts";

export const MCP_CONTROL_INVENTORY_REQUEST_EVENT = "senpi.rpc.mcp_inventory.request";
export const MCP_CONTROL_INVENTORY_CHANGED_EVENT = "senpi.rpc.mcp_inventory.changed";

export interface McpControlInventoryRequest {
	readonly sessionId: string;
	respond(snapshot: Promise<McpWireStatusSnapshot>): void;
}

export interface McpControlInventoryChanged {
	readonly sessionId: string;
	readonly snapshot: McpWireStatusSnapshot;
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
