import type { ToolRuntimeKind } from "../../cli/tool-runtime.ts";

import type { createRpcSessionBinding } from "./session-binding.ts";

import type { RpcSessionLaunchProfile } from "./session-registry.ts";

/** Binding factory seam, injectable so host wiring is testable without a full runtime stack. */
export type RpcBindingFactory = typeof createRpcSessionBinding;

/**
 * What the host supplies to every `open_session`. `hostContext` is the host's own identity
 * (`host_socket`, `host_instance`); it is merged OVER the client's context, because the host is the
 * authority on which endpoint and generation a session runs behind.
 */
export type RpcHostSessionDefaults = Pick<
	RpcSessionLaunchProfile,
	"cwd" | "permissionPreset" | "creationModel" | "initialThinkingLevel"
> & {
	readonly hostContext?: RpcSessionLaunchProfile["sessionContext"];
	/** The host's own agent dir (captured at startup); reported as `agentDir` so it survives a cwd change. */
	readonly agentDir?: string;
	/** The host's `--tool-runtime`; absent means `in-process`. */
	readonly toolRuntime?: ToolRuntimeKind;
};

/**
 * Occupancy policy for the shared multi-session host. All fields are opt-in:
 * a router constructed without a policy keeps today's behavior (sessions live
 * until close_session; the host never self-exits).
 */
export interface RpcSessionIdlePolicy {
	/** Injectable clock (defaults to Date.now) for deterministic tests. */
	now?: () => number;
	/** Evict open sessions whose last routed command or session-owned work settled longer ago than this. */
	idleEvictionMs?: number;
	/** Invoke onEmptyExit once the registry has stayed empty for this long. */
	emptyExitMs?: number;
	/** Host shutdown hook fired by the empty-exit window; called at most once. */
	onEmptyExit?: () => void;
	/** Close connections whose last attached session has finished handoff parking. */
	onHandoffParked?: (connections: readonly string[]) => Promise<void>;
	/**
	 * Endpoint daemon directory the drain appends the handoff-parked residency record to
	 * (senpi#3282), so the successor reopens exactly the set this host held resident. Absent,
	 * the park is not persisted (the old behavior).
	 */
	handoverParkedDir?: string;
	/**
	 * Consulted every tick before the empty-exit window advances. Returning false
	 * both blocks the exit and resets the window, so a host with a connected but
	 * sessionless client stays up instead of exiting under its supervisor.
	 */
	canExitWhenEmpty?: () => boolean;
}

/**
 * How one caller claims a close. `detach` (a client going away) is the only mode a
 * retained session may answer by staying open, so it is unrepresentable together
 * with `drainAttachments` - draining ENDS the session and must always reach zero.
 */
export type CloseClaimOptions =
	| { drainAttachments: true; detach?: never }
	| { drainAttachments: false; detach?: boolean };
