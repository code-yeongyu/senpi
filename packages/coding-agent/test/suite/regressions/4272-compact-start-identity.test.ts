import { afterEach, expect, it } from "vitest";
import { CompactSessionState } from "../../../src/modes/rpc/compact-session-state.ts";
import { spoolRoot } from "../compact-storage-support.ts";

// senpi#4272 / RULING-36a,38: identity is producer-supplied and acceptance is atomic.
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});
async function setup(compactAboveRows = 128) {
	const root = await spoolRoot();
	const state = new CompactSessionState({ dir: root.dir, compactAboveRows });
	cleanup.push(async () => {
		await state.retire();
		await root.cleanup();
	});
	return state;
}
const start = (epoch: string, ordinal: number, messageId = `${epoch}-${ordinal}`) => ({
	type: "block_start" as const,
	epoch,
	ordinal,
	firstOrdinal: ordinal,
	messageId,
	contentIndex: 0,
	kind: "text" as const,
	seed: "body",
	coveredCodeUnits: 0,
});

it.each([
	[
		"retired epoch",
		[
			["A", 0],
			["B", 0],
		],
		["A", 1],
	],
	["duplicate ordinal", [["A", 0]], ["A", 0]],
	["same-epoch reset", [["A", 7]], ["A", 0]],
] as const)("rejects %s without publishing", async (_label, accepted, rejected) => {
	const state = await setup();
	for (const [epoch, ordinal] of accepted) state.accept(start(epoch, ordinal));
	const sequence = state.acceptedSequence;
	const status = state.storageStatus();
	expect(() => state.accept(start(rejected[0], rejected[1], "different-key"))).toThrow(
		expect.objectContaining({ reason: "duplicate_or_stale_start" }),
	);
	expect(state.acceptedSequence).toBe(sequence);
	expect(state.storageStatus()).toEqual(status);
});

it("accepts never-seen epochs in consumer order, including ordinal zero after restart", async () => {
	const state = await setup();
	for (const [epoch, ordinal] of [
		["A", 4],
		["B", 0],
		["C", 0],
	] as const)
		state.accept(start(epoch, ordinal));
	expect(state.acceptedSequence).toBe(3);
});

it("keeps a live old-epoch message readable but refuses further starts after rollover", async () => {
	const state = await setup();
	state.accept(start("A", 0, "live"));
	state.accept(start("B", 0));
	for (const [epoch, reason] of [
		["A", "duplicate_or_stale_start"],
		["B", "invalid_start_identity"],
	] as const) {
		expect(() => state.accept({ ...start(epoch, 1, "live"), firstOrdinal: 0, contentIndex: 1 })).toThrow(
			expect.objectContaining({ reason }),
		);
		expect(state.acceptedSequence).toBe(2);
	}
	state.accept({ type: "block_delta", messageId: "live", contentIndex: 0, offset: 4, text: "!" });
	state.accept({ type: "message_status", messageId: "live", persistence: "appended" });
	const cut = state.freeze();
	try {
		expect((await state.read(cut)).messages.find((m) => m.messageId === "live")?.blocks).toEqual([
			{ contentIndex: 0, kind: "text", text: "body!" },
		]);
	} finally {
		state.release(cut);
	}
});

it.each([undefined, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
	"rejects missing or invalid ordinal %s without retiring the current epoch",
	async (ordinal) => {
		const state = await setup();
		state.accept(start("A", 0));
		const input = { ...start("B", 1), ordinal };
		expect(() => Reflect.apply(state.accept, state, [input])).toThrow(
			expect.objectContaining({ reason: "invalid_start_identity" }),
		);
		expect(state.accept(start("A", 1))).toBe(2);
	},
);

it("rejects a missing epoch and preserves the high-water mark after another validation failure", async () => {
	const state = await setup();
	const { epoch: _epoch, ...missing } = start("A", 0);
	expect(() => Reflect.apply(state.accept, state, [missing])).toThrow(
		expect.objectContaining({ reason: "invalid_start_identity" }),
	);
	expect(() => state.accept({ ...start("B", 99), coveredCodeUnits: 1 })).toThrow(
		expect.objectContaining({ reason: "invalid_coverage" }),
	);
	expect(state.accept(start("A", 0))).toBe(1);
	expect(state.accept(start("B", 0))).toBe(2);
});

it("keeps precisely the last 64 retired epochs at the 65th retirement", async () => {
	const state = await setup();
	for (let i = 0; i <= 65; i++) state.accept(start(`epoch-${i}`, 0));
	expect(() => state.accept(start("epoch-1", 1))).toThrow(
		expect.objectContaining({ reason: "duplicate_or_stale_start" }),
	);
	// Epoch 0 has left the explicitly bounded replay window.
	expect(state.accept(start("epoch-0", 1))).toBe(67);
	expect(() => state.accept(start("epoch-65", 1))).toThrow(
		expect.objectContaining({ reason: "duplicate_or_stale_start" }),
	);
});

it("rejects a reused settled identity after page-out and after its key is removed", async () => {
	const state = await setup(1);
	state.accept(start("A", 0));
	state.accept({ type: "message_status", messageId: "A-0", persistence: "pending" });
	await state.idle();
	expect(state.storageStatus().baseRows).toBe(1);
	expect(() => state.accept(start("A", 0))).toThrow(expect.objectContaining({ reason: "duplicate_or_stale_start" }));
	await state.applyCold({ type: "message_remove", messageId: "A-0" });
	expect(() => state.accept(start("A", 0))).toThrow(expect.objectContaining({ reason: "duplicate_or_stale_start" }));
	expect(state.accept(start("A", 1))).toBe(3);
});
