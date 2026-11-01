import { expect, it } from "vitest";
import { seededOwner } from "./4272-seeded-owner-support.ts";

// senpi#4272 / T6: actual captured seeds must reach the owning current-state boundary.
it.each([0, 2])("T6 owns a captured seed with explicit frontier %s", async (offset) => {
	await using owner = await seededOwner();
	const { state, partial } = owner;
	partial.content.push({ type: "text", text: "Hé", textSignature: "" });
	owner.push({ type: "text_start", contentIndex: 0, partial }, { offset });
	const before = state.freeze();
	for (const delta of offset === 0 ? ["", "H", "é!"] : ["", "!"])
		owner.push({ type: "text_delta", contentIndex: 0, delta, partial });
	partial.content = [];
	try {
		expect((await state.read(before)).messages[0]).toMatchObject({
			message: { content: [{ type: "text", text: "Hé", textSignature: "" }] },
		});
		expect((await owner.view()).messages[0]).toMatchObject({
			message: { content: [{ type: "text", text: "Hé!", textSignature: "" }] },
		});
	} finally {
		state.release(before);
	}
});

it.each([-1, 0.5, 1, 3, NaN, Infinity, undefined])(
	"T6 rejects malformed initial frontier %s atomically",
	async (nextOffset) => {
		await using owner = await seededOwner();
		const { partial, state } = owner;
		partial.content.push({ type: "text", text: "Hé" });
		const event = owner.project({ type: "text_start", contentIndex: 0, partial });
		if (event.type !== "text_start") throw new Error("missing text seed");
		expect(() => owner.malformed({ ...event, seed: { ...event.seed, nextOffset } })).toThrow(
			expect.objectContaining({ reason: "invalid_seed_frontier" }),
		);
		expect(state.acceptedSequence).toBe(0);
		expect((await owner.view()).messages).toEqual([]);
		owner.accept(event);
		expect((await owner.view()).messages[0]?.blocks[0]?.text).toBe("Hé");
	},
);

it.each([
	[0, "wrong", "non_contiguous"],
	[3, "gap", "non_contiguous"],
	[-1, "", "non_contiguous"],
	[NaN, "", "non_contiguous"],
])("T6 rejects a continuation delta at %s without changing the cut", async (offset, delta, reason) => {
	await using owner = await seededOwner();
	const { state, partial } = owner;
	partial.content.push({ type: "text", text: "Hé" });
	owner.push({ type: "text_start", contentIndex: 0, partial });
	const before = await owner.view();
	const status = state.storageStatus();
	expect(() => owner.accept({ type: "text_delta", contentIndex: 0, offset, delta })).toThrow(
		expect.objectContaining({ reason }),
	);
	expect(await owner.view()).toEqual(before);
	expect(state.storageStatus().residentTailBytes).toBe(status.residentTailBytes);
	expect(state.storageStatus().hotWitnessBytes).toBe(status.hotWitnessBytes);
});

it("T6 rejects conflicting replay and repeated seeds without losing the original witness", async () => {
	await using owner = await seededOwner();
	const { partial, state } = owner;
	partial.content.push({ type: "text", text: "Hé" });
	const event = owner.project({ type: "text_start", contentIndex: 0, partial }, { offset: 0 });
	owner.accept(event);
	expect(() => owner.accept({ type: "text_delta", contentIndex: 0, offset: 0, delta: "Hx" })).toThrow(
		expect.objectContaining({ reason: "conflicting_overlap" }),
	);
	expect(() => owner.accept(event)).toThrow(expect.objectContaining({ reason: "duplicate_block" }));
	expect(state.acceptedSequence).toBe(1);
	owner.accept({ type: "text_delta", contentIndex: 0, offset: 0, delta: "Hé!" });
	expect((await owner.view()).messages[0]?.blocks[0]?.text).toBe("Hé!");
});

it.each(["😀", "\uD800", "e\u0301", '\\"\\\\\\u0041'])("T6 preserves each UTF-16 replay split of %s", async (value) => {
	for (let boundary = 0; boundary <= value.length; boundary++) {
		await using owner = await seededOwner();
		const { partial } = owner;
		partial.content.push({ type: "text", text: value });
		owner.push({ type: "text_start", contentIndex: 0, partial }, { offset: 0 });
		owner.push({ type: "text_delta", contentIndex: 0, delta: value.slice(0, boundary), partial });
		owner.push({ type: "text_delta", contentIndex: 0, delta: `${value.slice(boundary)}!`, partial });
		await owner.state.idle();
		expect((await owner.view()).messages[0]?.blocks[0]?.text).toBe(`${value}!`);
	}
});
