import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Creates the agent dir, and any parent it has to create, as 0700 whatever the umask (senpi#6560). The RPC host
 * takes the agent dir as its key root and refuses one that group or others can write (`rpc-public-key.ts`), so a
 * directory senpi itself creates must never carry the umask's group bits.
 *
 * Only directories this call created are re-moded. An existing directory keeps its mode: a group-writable one that
 * senpi did not create here is still refused by the key-root check, with its `chmod go-w` hint.
 */
export function ensureAgentDir(agentDir: string): void {
	const created = mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	if (created === undefined) return;
	const stop = dirname(resolve(created));
	for (let dir = resolve(agentDir); dir !== stop; dir = dirname(dir)) chmodSync(dir, 0o700);
}
