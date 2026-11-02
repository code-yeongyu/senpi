import { afterEach, expect, it, vi } from "vitest";
import { callsComponents } from "../../../src/modes/rpc/compact-catalog-calls.ts";
import type { RecoveryRoute } from "../../../src/modes/rpc/compact-recovery-state.ts";
import type { RecoveryOutcome } from "../../../src/modes/rpc/compact-recovery-types.ts";
import { cutStructuredBytes, recoveryRig } from "./4272-recovery-support.ts";

// Part of #4272 (S10b, X03, #4568 review LOW 1): the completeness gate is wired into the manifest path itself. When
// one adapter of a complete-producer family emits nothing, the manifest build is refused typed, the partly built
// catalog tree is released, and no root outlives the token.

vi.mock("../../../src/modes/rpc/compact-catalog-calls.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/modes/rpc/compact-catalog-calls.ts")>();
	return { ...actual, callsComponents: vi.fn(actual.callsComponents) };
});

afterEach(() => {
	vi.restoreAllMocks();
});

const caller = { socketEpoch: "socket-1", sessionId: "s" };
const route = (): RecoveryRoute => ({
	socketEpoch: "socket-1",
	admissionId: "attach-1",
	routeKind: "ordinary",
	peer: "peer",
	sessionId: "s",
});

function unwrap<T>(outcome: RecoveryOutcome<T>): T {
	if (!outcome.ok) throw new Error(`refused: ${JSON.stringify(outcome.failure)}`);
	return outcome.value;
}

it("X03 a complete-producer family whose adapter emits nothing refuses the manifest, releases the built tree and leaves no live root", async () => {
	// Given: a fresh epoch with no outstanding call, so the calls adapter would emit its explicit empty
	const rig = recoveryRig();
	await rig.lane.idle();
	const probe = rig.lane.freeze();
	const token = unwrap(rig.checkpoints.freeze(route(), rig.lane)).token;
	const before = await cutStructuredBytes(rig.lane, probe);
	// When: the calls adapter emits nothing at all for this one build
	vi.mocked(callsComponents).mockImplementationOnce(async function* () {});
	const refused = await rig.checkpoints.catalog(token, caller);
	// Then: the gate refused the catalog typed, and every node the build had written is released again
	expect(refused).toEqual({ ok: false, failure: { kind: "storage_unavailable", reason: "unavailable" } });
	await rig.lane.idle();
	expect(await cutStructuredBytes(rig.lane, probe), "the refused build left no catalog node behind").toEqual(before);
	// And: with the adapter restored the same token builds, and releasing it leaves no live root
	expect(unwrap(await rig.checkpoints.catalog(token, caller)).catalogRoot).toEqual(expect.any(String));
	rig.checkpoints.release(token);
	rig.lane.release(probe);
	expect(rig.lane.liveRoots).toBe(0);
	await rig.lane.idle();
});
