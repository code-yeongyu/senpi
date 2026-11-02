/**
 * The rpc monitor source loads on its first watch: it reaches the RPC socket transport, which a session
 * that never arms an rpc monitor should not load.
 */
export function loadRpcMonitorSource(): Promise<typeof import("./rpc-monitor-source.ts")> {
	return import("./rpc-monitor-source.ts");
}
