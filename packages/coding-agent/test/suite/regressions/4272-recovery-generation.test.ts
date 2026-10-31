import { afterEach, expect, expectTypeOf, it, vi } from "vitest";
import type { RecoveryRoute } from "../../../src/modes/rpc/compact-recovery-state.ts";
import type { RecoveryAdmission } from "../../../src/modes/rpc/compact-recovery-types.ts";
import { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { EVENT_RESYNC_CAPABILITY } from "../../../src/modes/rpc/socket-peer-recovery.ts";
import { heldPeer } from "./4272-legacy-view-support.ts";
import { recoveryRig as rig, streaming } from "./4272-recovery-support.ts";

// Part of #4272 (S08a, RULING-50 (1) and the S08a review LOW-1/LOW-2): the fanout's attach and shed mint one
// generation sequence per peer + session incarnation, in either order; it restarts only with a new incarnation, and
// a dropped peer's open checkpoint is reclaimed with an operation still in flight on it refused as peer_gone.

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

it("RULING-50 (1) generations increase strictly within one peer + session incarnation across attach and shed in both orders, and restart only with a new incarnation", async () => {
	vi.useFakeTimers();
	const { writer, lane, attach, shed, replace } = rig();
	const held = heldPeer(writer, "held", [EVENT_RESYNC_CAPABILITY]);
	const minted = [await attach(held), await shed(held)];
	writer.detachConnectionFromSession("held", "s");
	minted.push(await attach(held), await shed(held));
	expect(
		minted.map(({ generation }) => generation),
		"attach then shed, shed then attach, attach then shed",
	).toEqual([1, 2, 3, 4]);
	expect(new Set(minted.map(({ socketEpoch, sessionEpoch }) => `${socketEpoch} ${sessionEpoch}`)).size).toBe(1);
	expect(minted.map(({ admissionId }) => admissionId)).toEqual(["attach-1", "attach-1", "attach-2", "attach-2"]);
	expect(
		minted.every(({ routeKind }) => routeKind === "ordinary"),
		"the fanout produces only ordinary",
	).toBe(true);

	const epoch = lane.sessionEpoch;
	replace();
	const replaced = await shed(held);
	expect(replaced, "a new session incarnation restarts the sequence").toMatchObject({ generation: 1 });
	expect(replaced.sessionEpoch).not.toBe(epoch);

	writer.unregisterConnection("held");
	const again = heldPeer(writer, "held", [EVENT_RESYNC_CAPABILITY]);
	const reborn = await attach(again);
	expect(reborn, "a new peer incarnation restarts the sequence").toMatchObject({ generation: 1 });
	expect(reborn.socketEpoch).not.toBe(minted[0]?.socketEpoch);
	writer.unregisterConnection("held");
	lane.retire("close");
	await lane.idle();
});

it("RULING-46 (1) the descriptor's routeKind is ordinary | mirror and the owner takes either without narrowing", async () => {
	expectTypeOf<RecoveryAdmission["routeKind"]>().toEqualTypeOf<"ordinary" | "mirror">();
	expectTypeOf<RecoveryRoute["routeKind"]>().toEqualTypeOf<"ordinary" | "mirror">();
	const checkpoints = new SessionEventWriter(() => {}).recoveryCheckpoints;
	const lane = new SessionAcceptanceLane();
	lane.bootstrap({ transcript: [] });
	const route: RecoveryRoute = {
		socketEpoch: "socket-1",
		admissionId: "m",
		routeKind: "mirror",
		peer: "p",
		sessionId: "s",
	};
	const frozen = checkpoints.freeze(route, lane);
	expect(frozen.ok && frozen.value.token.admission).toMatchObject({ routeKind: "mirror", generation: 1 });
	if (frozen.ok) checkpoints.release(frozen.value.token);
	lane.retire("close");
	await lane.idle();
});

it.each(["unregistered", "dropped by its failed queue"] as const)(
	"S08a review LOW-1/LOW-2 a peer %s while its checkpoint is open: the cut is reclaimed and a read in flight is refused as peer_gone",
	async (how) => {
		vi.useFakeTimers();
		const { writer, lane, checkpoints } = rig();
		vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const late = heldPeer(writer, "late", how === "unregistered" ? [EVENT_RESYNC_CAPABILITY] : []);
		late.hold();
		writer.attachConnectionToSession("late", "s");
		const [token] = checkpoints.tokens();
		if (!token) return expect.unreachable();
		expect(lane.liveRoots).toBe(1);
		const rootsReleased = new Promise<void>((resolve) => {
			const release = lane.release.bind(lane);
			vi.spyOn(lane, "release").mockImplementation((root) => {
				release(root);
				if (lane.liveRoots === 0) resolve();
			});
		});
		const reading = checkpoints.readActive(token, token.admission);
		if (how === "unregistered") writer.unregisterConnection("late");
		else {
			const producer = streaming(writer, lane);
			for (let index = 0; index < 200 && writer.hasConnection("late"); index++)
				producer.blockDelta("text", 0, "x", index);
			expect(writer.hasConnection("late"), "the plain peer's overflow failed its queue").toBe(false);
		}
		expect(await reading).toEqual({ ok: false, failure: { kind: "repair_needed", reason: "peer_gone" } });
		// The queued attach view's own read is an operation in flight too (S08b review MEDIUM): the root goes once it unwinds.
		await rootsReleased;
		expect(checkpoints.open).toBe(0);
		expect(lane.liveRoots).toBe(0);
		expect(await checkpoints.readActive(token, token.admission)).toEqual({
			ok: false,
			failure: { kind: "repair_needed", reason: "unknown_token" },
		});
		lane.retire("close");
		await lane.idle();
	},
);
