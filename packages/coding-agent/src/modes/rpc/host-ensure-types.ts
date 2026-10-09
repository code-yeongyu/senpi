/** The options and result of `ensureHost`, kept apart so the ensure's helpers can name them without a cycle. */
import type { HostLifecyclePolicyInput } from "./host-lifecycle.ts";

/**
 * What an ensure may do to a host that is already running.
 *
 * `never` (the default) attaches or starts, and touches nothing that is already serving the
 * socket. `if-engine-differs` additionally allows a GENERATION HANDOFF when `decideHostAction`
 * finds this build strictly newer and its extension set a superset of the running host's - the
 * running host then drains instead of dying, so no session is ever ended by an upgrade.
 */
export type HostUpgradePolicy = "never" | "if-engine-differs";

export interface EnsureHostOptions {
	readonly socket: string;
	readonly agentDir?: string;
	/** Opt in to this caller process's lifetime. Attach holds remain independently releasable. */
	readonly owner?: "caller";
	/** Host lifecycle policy recorded in settings.json (env overrides win at runtime). */
	readonly policy?: HostLifecyclePolicyInput;
	/** Extra CLI arguments forwarded through the supervisor to the host process. */
	readonly hostArgs?: readonly string[];
	/** Environment for the spawned host; a `null` value removes an inherited variable. */
	readonly env?: Readonly<Record<string, string | null>>;
	/** Whether a newer build may take the socket over from the running host. Defaults to `never`. */
	readonly upgrade?: HostUpgradePolicy;
	readonly _test?: {
		readonly readinessTimeoutMs?: number;
		readonly stopTimeoutMs?: number;
		readonly spawn?: { readonly command: string; readonly args: readonly string[] };
		/** Builds the spawnable command from supervisor argv; tests point it at the source entry. */
		readonly launch?: (args: readonly string[]) => { readonly command: string; readonly args: readonly string[] };
		/** Runs after endpoint ownership is locked; deterministic concurrency-test gate. */
		readonly afterLockAcquired?: () => Promise<void>;
		/**
		 * Runs after the child is spawned but before its pidfile is registered, so a
		 * test can force the startup failure a loaded runner produces without having
		 * to stall the real process-identity probe.
		 */
		readonly beforePidFileWrite?: () => Promise<void>;
		/** Runs after readiness failed and before the start is torn down; deterministic teardown-test gate. */
		readonly beforeReadinessTeardown?: () => Promise<void>;
		/** Overrides the process-identity probe so a test can force its failure. */
		readonly readProcessStartTime?: (pid: number) => Promise<string | undefined>;
	};
}

export interface EnsuredHost {
	readonly pid: number;
	readonly socket: string;
	readonly reused: boolean;
	/**
	 * Ends this ensure's attach hold (host-attach-hold.ts). Until then the host counts this client as
	 * attached, so its idle window cannot close before the client's own connection is up; release it
	 * once that connection is attached, or when the client no longer needs the host.
	 */
	readonly release: () => void;
}
