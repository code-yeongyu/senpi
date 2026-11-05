import type { ModelEgress, StreamFn } from "@earendil-works/pi-agent-core";

/**
 * The fused / one-machine egress: every provider is dialed directly by today's stream function, handed back
 * unchanged (no wrapper, no re-packing). It never sets the loop's `commitStep`.
 */
export function createDirectEgress(deps: { readonly streamFn: StreamFn }): ModelEgress {
	return { routeFor: () => ({ route: "direct", reason: "fused", servedNow: true }), stream: deps.streamFn };
}
