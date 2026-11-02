import type { HostRequest } from "./host-runner.ts";
import { rpcKeyRoot } from "./rpc-auth-client.ts";

/**
 * Where a host request proves endpoint keys from (senpi#3815): the caller's explicit `--rpc-key-root`, then a gc's
 * explicit target directory (it dials that directory's endpoints, whose hosts published their records there), then
 * an enclosing key root, `SENPI_RPC_KEY_ROOT`, and finally the target's agent dir.
 */
export function hostRequestKeyRoot(request: HostRequest, explicit?: string): string {
	if (explicit !== undefined) return explicit;
	if (request.action === "gc") return request.agentDir;
	return rpcKeyRoot({}, request.action === "shard_path" ? undefined : request.target.agentDir);
}
