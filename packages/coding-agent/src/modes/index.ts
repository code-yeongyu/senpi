/**
 * Run modes for the coding agent.
 */

export { InteractiveMode, type InteractiveModeOptions } from "./interactive/interactive-mode.ts";
export type { JsonAgentSessionEvent } from "./json-event.ts";
export { type PrintModeOptions, runPrintMode } from "./print-mode.ts";
export {
	createHostDaemonPaths,
	type EnsuredHost,
	type EnsureHostOptions,
	ensureHost,
	type HostDaemonPaths,
	PINNED_HOST_CLIENT_CAPABILITIES,
} from "./rpc/host-ensure.ts";
export {
	type ModelInfo,
	RpcClient,
	type RpcClientEvent,
	type RpcClientOptions,
	type RpcEventListener,
} from "./rpc/rpc-client.ts";
export { runRpcMode } from "./rpc/rpc-mode.ts";
export type {
	RpcCommand,
	RpcExtensionEvent,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
} from "./rpc/rpc-types.ts";
