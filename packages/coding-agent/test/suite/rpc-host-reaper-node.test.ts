/**
 * The child reaper on a runtime without the bun:ffi bindings. rpc-host-reaper.test.ts runs under Bun (it opens
 * persisted sessions, senpi#5822), so this Node case lives in its own Node-hosted file and keeps running on Node.
 */
import { expect, it } from "vitest";
import { startHostChildReaper } from "../../src/modes/rpc/child-reaper.ts";
import { loadChildReaperSyscalls } from "../../src/modes/rpc/child-reaper-syscalls.ts";

it.skipIf(process.versions.bun !== undefined)("does nothing but warn on a runtime without the syscalls", async () => {
	// Given: Node, which has no bun:ffi bindings (under Bun, rpc-host-reaper.test.ts covers the armed case).
	const logged: string[] = [];

	// When: the host arms the reaper.
	const stop = await startHostChildReaper((message) => logged.push(message));

	// Then: no bindings, one warning naming the runtime, and a stop that is safe to call.
	expect(await loadChildReaperSyscalls()).toBeUndefined();
	expect(logged).toHaveLength(1);
	expect(logged[0]).toContain("Node");
	expect(() => stop()).not.toThrow();
});
