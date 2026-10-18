import type { PreparableRuntimeFactory } from "./host-warm.ts";
import { RpcSessionRegistry } from "./session-registry.ts";

/**
 * The registry a session worker runs its one session in. The worker owns its isolate's event
 * loop, so the session file loads in one synchronous pass: slicing it (senpi#3518) only helps
 * a loop that other sessions share, and a worker blocked in a native read is what the host's
 * quarantine and ownership rules are built to handle.
 */
export function createSessionWorkerRegistry(
	agentDir: string,
	createRuntime: PreparableRuntimeFactory,
): RpcSessionRegistry {
	return new RpcSessionRegistry({ agentDir, createRuntime, sessionFileLoad: "blocking" });
}
