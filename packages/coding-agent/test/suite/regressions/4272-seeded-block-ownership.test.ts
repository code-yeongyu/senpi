import { expect, it } from "vitest";
import { seededOwner } from "./4272-seeded-owner-support.ts";

// senpi#4272 / T6: rejected records preserve the owner's accepted roots and accounting.
it("T6 rejects a foreign epoch without replacing the captured block", async () => {
	await using owner = await seededOwner();
	const { partial, state } = owner;
	partial.content.push({ type: "text", text: "seed" });
	owner.push({ type: "text_start", contentIndex: 0, partial });
	const before = await owner.view();
	expect(() =>
		state.accept({
			type: "seeded_block",
			messageId: "message",
			epoch: "foreign",
			ordinal: 100,
			firstOrdinal: 100,
			event: { type: "text_delta", contentIndex: 0, offset: 4, delta: "!" },
		}),
	).toThrow(expect.objectContaining({ reason: "wrong_epoch" }));
	expect(await owner.view()).toEqual(before);
});

const native = (value: string) => ({ type: "providerNative" as const, subtype: "fixture", raw: { value } });

// A native insert installs a new block; only its end is authoritative over an open block (S03b design section 4).
it.each([
	["an insert over an open native block", "providerNative", "insert", "duplicate_block"],
	["an insert over an open text block", "text", "insert", "duplicate_block"],
	["a native end of a text block", "text", "end", "wrong_kind"],
] as const)("T6 rejects %s without replacing it", async (_name, opened, phase, reason) => {
	await using owner = await seededOwner();
	const { partial, state } = owner;
	if (opened === "text") {
		partial.content.push({ type: "text", text: "seed" });
		owner.push({ type: "text_start", contentIndex: 0, partial });
	} else owner.control({ type: "message_block_state", contentIndex: 0, phase: "insert", block: native("first") });
	const before = await owner.view();
	const status = state.storageStatus();
	expect(() =>
		owner.control({ type: "message_block_state", contentIndex: 0, phase, block: native("second") }),
	).toThrow(expect.objectContaining({ reason }));
	expect(state.acceptedSequence).toBe(1);
	expect(await owner.view()).toEqual(before);
	expect(state.storageStatus()).toMatchObject({
		residentTailBytes: status.residentTailBytes,
		hotWitnessBytes: status.hotWitnessBytes,
	});
});

it.each([-1, 1, 3, 0.5, NaN, Infinity])(
	"T6 rejects invalid coverage %s before publication",
	async (coveredCodeUnits) => {
		await using owner = await seededOwner();
		const { partial, state } = owner;
		partial.content.push({ type: "text", text: "Hé" });
		const event = owner.project({ type: "text_start", contentIndex: 0, partial });
		if (event.type !== "text_start") throw new Error("missing text seed");
		expect(() => owner.accept({ ...event, seed: { ...event.seed, coveredCodeUnits } })).toThrow(
			expect.objectContaining({ reason: "invalid_coverage" }),
		);
		expect(state.acceptedSequence).toBe(0);
		expect((await owner.view()).messages).toEqual([]);
		owner.accept(event);
		expect((await owner.view()).messages[0]?.blocks[0]?.text).toBe("Hé");
	},
);

it("T6 preserves a held raw revision across reset and reclaims every block owner after release", async () => {
	await using owner = await seededOwner();
	const { partial, state } = owner;
	partial.content.push({ type: "toolCall", id: "call", name: "tool", arguments: { original: true } });
	owner.push({ type: "toolcall_start", contentIndex: 0, partial }, { rawArgumentPrefix: '{"a":1}', parsedThrough: 7 });
	await state.idle();
	const before = state.freeze();
	try {
		owner.control({
			type: "message_tool_arguments_reset",
			contentIndex: 0,
			rawArgumentPrefix: '{"b":',
			parsedThrough: 0,
		});
		owner.accept({ type: "toolcall_delta", contentIndex: 0, offset: 5, delta: "", parsedThrough: 0 });
		expect((await owner.view()).messages[0]).toMatchObject({
			blocks: [{ text: '{"b":' }],
			message: { content: [{ arguments: { original: true } }] },
		});
		state.accept({ type: "message_remove", messageId: "message" });
		await state.idle();
		expect((await state.read(before)).messages[0]).toMatchObject({
			blocks: [{ text: '{"a":1}' }],
			message: { content: [{ arguments: { a: 1 } }] },
		});
	} finally {
		state.release(before);
	}
	await state.idle();
	expect(state.storageStatus()).toMatchObject({
		residentPayloadBytes: 0,
		pendingIoCopyBytes: 0,
		pinnedOnlyBytes: 0,
		spilledLiveBytes: 0,
		reclaimDebtBytes: 0,
		residentTailBytes: 0,
		hotWitnessBytes: 0,
		frozenTailBytes: 0,
		residentComponentNodes: 0,
		residentTextNodes: 0,
		structuredBytes: { resident: 0, spilled: 0, pinned: 0 },
	});
});
