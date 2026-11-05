import { vi } from "vitest";
import { RpcSessionRegistry } from "../../src/modes/rpc/session-registry.ts";
import type { RpcSessionEntry } from "../../src/modes/rpc/session-registry-types.ts";
import type { statusHost } from "./rpc-session-status-support.ts";

type StatusHost = Awaited<ReturnType<typeof statusHost>>;

/**
 * The in-process entry of a session a status host opened, read by its routing id from the host's own registry
 * (senpi#5802). These tests used to take "the last value `getForCommand` returned" from a prototype spy, an
 * order-based lookup that intermittently found no session. The spy now only observes: when the old lookup would have
 * answered differently, one diagnostic line says whether the spy saw no call at all or a different, later return.
 */
export function observeInProcessOpens(host: StatusHost) {
	const spy = vi.spyOn(RpcSessionRegistry.prototype, "getForCommand");
	return {
		entryFor(sessionId: string): RpcSessionEntry {
			const entry = host.core.peekSession(sessionId);
			const last = spy.mock.results.findLast((result) => result.type === "return")?.value;
			if (last === entry && entry?.runtime !== undefined) return entry;
			const diagnostic = JSON.stringify({
				sessionId,
				spied: RpcSessionRegistry.prototype.getForCommand === spy,
				calls: spy.mock.calls,
				results: spy.mock.results.map((result) => ({
					type: result.type,
					sameAsEntry: result.value === entry,
					runtime: (result.value as RpcSessionEntry | undefined)?.runtime !== undefined,
				})),
				entry: entry === undefined ? null : { state: entry.state, runtime: entry.runtime !== undefined },
			});
			if (entry?.runtime === undefined) throw new Error(`senpi#5802 no in-process session: ${diagnostic}`);
			process.stderr.write(`senpi#5802 the spied last-return lookup would have diverged: ${diagnostic}\n`);
			return entry;
		},
		restore: () => spy.mockRestore(),
	};
}
