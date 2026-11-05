// senpi#5482 (QX1.win.S27a): KILL-HAND under the win32 profile. A Windows hand reached over a named-pipe endpoint is
// terminated signal-less mid-call (no handler of the dead hand writes anything durable after the kill), and recovery
// follows each placement's outcome. Windows behavior is simulated in code, never on a VM.
import { describe, expect, it } from "vitest";
import { KILL_HAND_CASES, KILL_HAND_DECLARATIONS } from "../../src/execution/testing/kill-hand.ts";
import { MULTI_HAND_CASES } from "../../src/execution/testing/multi-hand-cases.ts";
import { localEndpoint } from "../../src/transport/local-endpoint.ts";
import { handAdapters } from "./hand-adapters.ts";

const win32Adapters = () => handAdapters("win32");

describe("KILL-HAND under the win32 profile", () => {
	it("reaches the hand over a named pipe, as a Windows hand listens", () => {
		expect(localEndpoint("win32", "hand-conformance", "/run/senpi-conformance").kind).toBe("named-pipe");
	});

	for (const { id, placement, operation, at } of KILL_HAND_DECLARATIONS) {
		it(`${id}: signal-less kill ${at} ${operation} on ${placement} recovers per its placement`, async () => {
			const run = KILL_HAND_CASES.get(id);
			if (run === undefined) throw new Error(`no implementation for ${id}`);
			await run(win32Adapters());
		});
	}

	it("MULTI-KILL-01: several scopes in flight on a Windows hand each recover independently", async () => {
		const run = MULTI_HAND_CASES.get("MULTI-KILL-01");
		if (run === undefined) throw new Error("no implementation for MULTI-KILL-01");
		await run(win32Adapters());
	});
});
