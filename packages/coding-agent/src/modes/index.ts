/**
 * Run modes for the coding agent.
 */

export { InteractiveMode, type InteractiveModeOptions } from "./interactive/interactive-mode.ts";
export type { JsonAgentSessionEvent } from "./json-event.ts";
export { type PrintModeOptions, runPrintMode } from "./print-mode.ts";
// The shard naming contract every client computes identically; `senpi host shard-path` prints the same.
export {
	daemonDirectoryName,
	ENDPOINT_REGISTRY_VERSION,
	type EndpointKind,
	type ShardKind,
	shardKey,
	shardSocketPath,
	shardSocketPathForKey,
} from "./rpc/host-daemon-paths.ts";
// Host compatibility and upgrade decisions: protocol version + capabilities + ordinal, never a version string
export {
	decideHostAction,
	GENERATION_HANDOFF_CAPABILITY,
	HOST_PROTOCOL_VERSION,
	type HostAction,
	type HostDecision,
	type HostDecisionClient,
	type HostDecisionPolicy,
	type HostDecisionWarning,
	HostEnsureRefusedError,
	type HostProtocolInfo,
	type HostRefusalReason,
	parseHostProtocolInfo,
	REQUIRED_HOST_CAPABILITIES,
} from "./rpc/host-decision.ts";
// The one endpoint registry: which endpoints an agent directory holds, whether each can be reached,
// and the evidence-gated removal of the ones that provably ended.
export {
	classifyEndpointLiveness,
	type EndpointLiveness,
	endpointProbeTimeoutMs,
	TUI_PROBE_TIMEOUT_MS,
} from "./rpc/host-endpoint-liveness.ts";
export { type HostEndpointEntry, type HostEndpointIdentitySource, listHostEndpoints } from "./rpc/host-endpoints.ts";
export {
	createHostDaemonPaths,
	type EnsuredHost,
	type EnsureHostOptions,
	ensureHost,
	type HostDaemonPaths,
	type HostUpgradePolicy,
	PINNED_HOST_CLIENT_CAPABILITIES,
} from "./rpc/host-ensure.ts";
export { gcHostEndpoints, type HostGcOptions, type HostGcResult } from "./rpc/host-gc.ts";
// Replacing a running daemon without ending its work: the drain-based generation handoff,
// the identity probe every decision starts from, and the two ways a generation is ended.
export {
	type HandoffHostOptions,
	type HandoffRefusal,
	type HandoffResult,
	handoffHost,
} from "./rpc/host-handoff.ts";
// What a client hands `senpi host` to describe the daemon it wants, and the trust boundary it crosses.
export {
	DEFAULT_HOST_LAUNCH_SPEC,
	type HostLaunchSpec,
	type HostLaunchSpecCore,
	HostLaunchSpecError,
	type HostLaunchSpecRefusal,
	loadHostLaunchSpec,
	parseHostLaunchSpec,
	type ResolvedHostLaunchSpec,
} from "./rpc/host-launch-spec.ts";
export { type ProbeHostOptions, probeHost } from "./rpc/host-probe.ts";
// One host request - ensure, status, stop, handoff - and the exit codes its outcomes mean.
export {
	HOST_EXIT_ERROR,
	HOST_EXIT_FALLBACK,
	HOST_EXIT_OK,
	HOST_EXIT_REFUSED,
	HOST_EXIT_USAGE,
	type HostOutcome,
	type HostRequest,
	type HostTarget,
	runHostRequest,
} from "./rpc/host-runner.ts";
export {
	type HostGenerationRow,
	type HostSessionCounts,
	type HostStatusOptions,
	type HostStatusReport,
	readHostStatus,
} from "./rpc/host-status.ts";
export { type HostEndpointStatus, readAllHostStatus } from "./rpc/host-status-all.ts";
export { type StopHostOptions, type StopHostResult, stopHost } from "./rpc/host-stop.ts";
export {
	isTransportGoneError,
	type ModelInfo,
	RpcClient,
	type RpcClientEvent,
	RpcClientOpenInFlightError,
	type RpcClientOptions,
	type RpcEventListener,
	RpcTransportGoneError,
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
