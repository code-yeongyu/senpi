import { afterEach, expect, it, vi } from "vitest";
import { EVENT_RESYNC_CAPABILITY } from "../../../src/modes/rpc/socket-peer-recovery.ts";
import { heldPeer } from "./4272-legacy-view-support.ts";
import { recoveryRig } from "./4272-recovery-support.ts";

// Part of #4272 (S08b, R3.C1.2-C1.5, RULING-42 Q2 A, RULING-46 item 1): one stream record per peer + session
// incarnation carries S08a's generation counter and its admitted routes; the first admission and a reset advance it,
// a duplicate hold does not. The records' lifetime is 4272-recovery-session-end, the resync cut's root 4272-recovery-resync-root.

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

it("carry 32 RULING-50 (1) the stream record's generation is the number the token carries: attach, shed and re-attach read one counter", async () => {
	vi.useFakeTimers();
	const { writer, lane, checkpoints, attach, shed } = recoveryRig();
	const held = heldPeer(writer, "held", [EVENT_RESYNC_CAPABILITY]);
	const same = async (step: typeof attach) => {
		const admission = await step(held);
		expect(checkpoints.stream(admission)?.generation, "the record and the token name one number").toBe(
			admission.generation,
		);
		return admission;
	};
	const first = await same(attach);
	await same(shed);
	expect(checkpoints.stream(first)).toEqual({
		sessionEpoch: lane.sessionEpoch,
		generation: 2,
		routes: ["attach-1"],
	});
	writer.detachConnectionFromSession("held", "s");
	expect(checkpoints.stream(first)?.routes, "a detach retires its route; the stream and its counter stay").toEqual([]);
	const again = await same(attach);
	expect(again.generation).toBe(3);
	expect(checkpoints.stream(first)).toMatchObject({ generation: 3, routes: ["attach-2"] });
	writer.unregisterConnection("held");
	expect(checkpoints.stream(first), "the record goes with the peer incarnation").toBeUndefined();
	lane.retire("close");
	await lane.idle();
});

it("T5 only the first admission and a reset advance the generation: a duplicate hold adds nothing, a reset adds no attachment, two peers' holds are two streams", async () => {
	vi.useFakeTimers();
	const { writer, lane, checkpoints, attach, shed } = recoveryRig();
	const held = heldPeer(writer, "held", [EVENT_RESYNC_CAPABILITY]);
	const other = heldPeer(writer, "other", [EVENT_RESYNC_CAPABILITY]);
	const first = await attach(held);
	writer.attachConnectionToSession("held", "s");
	expect(checkpoints.tokens(), "a duplicate hold freezes nothing").toEqual([]);
	expect(checkpoints.stream(first)).toMatchObject({ generation: 1, routes: ["attach-1"] });
	const reset = await shed(held);
	expect(reset.generation, "the reset is the next generation of the same stream").toBe(2);
	expect(reset.admissionId, "a reset adds no attachment: the same admission holds the session").toBe(
		first.admissionId,
	);
	expect(checkpoints.stream(first)).toMatchObject({ generation: 2, routes: ["attach-1"] });
	const overlapping = await attach(other, "other");
	expect(overlapping.socketEpoch).not.toBe(first.socketEpoch);
	expect(overlapping.generation, "another peer's hold is its own stream at generation 1").toBe(1);
	expect(checkpoints.stream(first)?.generation, "the first stream is untouched by the other peer").toBe(2);
	expect(checkpoints.status()).toMatchObject({ streams: 2, frozen: 3, reclaimed: 0 });
	for (const id of ["held", "other"]) writer.unregisterConnection(id);
	expect(checkpoints.status().streams).toBe(0);
	lane.retire("close");
	await lane.idle();
});

it("carry 37 a replacement keeps one stream record per peer and session: every incarnation restarts the counter in the same record", async () => {
	vi.useFakeTimers();
	const { writer, lane, checkpoints, attach, shed, replace } = recoveryRig();
	const held = heldPeer(writer, "held", [EVENT_RESYNC_CAPABILITY]);
	const first = await attach(held);
	const epochs = new Set([first.sessionEpoch]);
	for (let incarnation = 0; incarnation < 3; incarnation++) {
		replace();
		const minted = await shed(held);
		epochs.add(minted.sessionEpoch);
		expect(minted.generation).toBe(1);
		expect(checkpoints.status().streams, "one record per peer and session, whatever the incarnation").toBe(1);
		expect(checkpoints.stream(first)).toMatchObject({ sessionEpoch: minted.sessionEpoch, generation: 1 });
	}
	expect(epochs.size).toBe(4);
	writer.unregisterConnection("held");
	lane.retire("close");
	await lane.idle();
});

it.each([
	["unavailable storage", "compactUnavailable", 1],
	["a worker failure", "retire", 0],
] as const)(
	"carry 35 a shed on a lane retired by %s: the resync message is null and the 'current view unavailable' line is written for unavailable storage only",
	async (_how, step, lines) => {
		vi.useFakeTimers();
		const { writer, lane, checkpoints, producer, attach } = recoveryRig();
		const held = heldPeer(writer, "held", [EVENT_RESYNC_CAPABILITY]);
		await attach(held);
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		if (step === "compactUnavailable") lane.compactUnavailable(new Error("lost canonical record"));
		else lane.retire("worker_failed");
		held.hold();
		for (let index = 0; index < 20; index++) producer().blockDelta("text", 0, "x", index);
		expect(checkpoints.open, "a failed freeze pins nothing").toBe(0);
		held.release();
		await writer.flush();
		const resync = held.lines.find((line) => line.includes('"resync_required"') && line.includes('"sessionId":"s"'));
		expect(resync, "the per-session resync frame after the gap").toBeDefined();
		expect(JSON.parse(resync ?? "{}")).toMatchObject({ sessionId: "s", message: null });
		expect(
			stderr.mock.calls.filter(([line]) => String(line).includes("current view unavailable")),
			"the diagnostic names the unavailable storage, never a retired lane",
		).toHaveLength(lines);
		writer.unregisterConnection("held");
		lane.retire("close");
		await lane.idle();
	},
);

it("T5 X04 a re-attach that supersedes an attach baseline mid-read reclaims its root at once and quietly: no 'current view unavailable' line, the new baseline once", async () => {
	vi.useFakeTimers({ now: 1_000 });
	const { writer, lane, checkpoints } = recoveryRig();
	const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	const read = lane.readCurrentComponents.bind(lane);
	let owned: number[] | undefined;
	vi.spyOn(lane, "readCurrentComponents").mockImplementation(async (root) => {
		const components = await read(root);
		if (owned === undefined) {
			writer.detachConnectionFromSession("late", "s");
			writer.attachConnectionToSession("late", "s");
			owned = checkpoints.tokens().map(({ admission }) => admission.generation);
		}
		return components;
	});
	const late = heldPeer(writer, "late");
	writer.attachConnectionToSession("late", "s");
	await writer.flush();
	expect(owned, "the re-attach invalidated the first token; its root waits for the view's read in flight").toEqual([
		1, 2,
	]);
	expect(
		late.lines.filter((line) => line.includes('"message_start"')),
		"the new baseline, once",
	).toHaveLength(1);
	expect(stderr.mock.calls.filter(([line]) => String(line).includes("current view unavailable"))).toEqual([]);
	expect(checkpoints.open).toBe(0);
	expect(lane.liveRoots).toBe(0);
	expect(checkpoints.status()).toMatchObject({ frozen: 2, reclaimed: 1 });
	writer.unregisterConnection("late");
	lane.retire("close");
	await lane.idle();
});
