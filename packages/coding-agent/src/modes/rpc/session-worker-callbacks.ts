import type { SessionWriteGrant } from "./session-worker-protocol.ts";

/** Lifecycle hooks the owning registry installs on every worker it allocates. */
export interface SessionWorkerCallbacks {
	reserve: (path: string) => SessionWriteGrant | Promise<SessionWriteGrant>;
	/** Every snapshot republishes which paths this worker still writes. */
	reconcile: (livePaths: readonly string[]) => void | Promise<void>;
	exit: () => void | Promise<void>;
	failure: (error: string) => void;
}
