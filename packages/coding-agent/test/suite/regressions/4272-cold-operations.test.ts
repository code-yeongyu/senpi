import { expect, it, vi } from "vitest";
import { CompactContentIndex } from "../../../src/modes/rpc/compact-content-index.ts";
import { CompactSessionState } from "../../../src/modes/rpc/compact-session-state.ts";
import { controlledIo, spoolRoot, startBlock } from "../compact-storage-support.ts";

// senpi#4272: settled mutations must not enter synchronous acceptance or advance its sequence.
it.each(["message_status", "message_remove"] as const)("routes cold %s outside acceptance", async (type) => {
	const root = await spoolRoot();
	const state = new CompactSessionState({ dir: root.dir, compactAboveRows: 1 });
	try {
		state.accept(startBlock("cold", "body"));
		state.accept({ type: "message_status", messageId: "cold", persistence: "pending" });
		await state.idle();
		const sequence = state.acceptedSequence;
		expect(() => state.accept({ type, messageId: "cold", persistence: "appended" })).toThrow(
			expect.objectContaining({ reason: "cold_operation_required" }),
		);
		expect(state.acceptedSequence).toBe(sequence);
	} finally {
		await state.retire();
		await root.cleanup();
	}
});

// The real point read is held while unrelated acceptance proceeds; a removed key may be reused.
it("orders cold operations after acceptance without mutating active blocks or a reused key", async () => {
	const root = await spoolRoot();
	const io = controlledIo();
	const state = new CompactSessionState({ dir: root.dir, io: io.io, compactAboveRows: 1 });
	const hold = io.hold("read", (path) => path.includes("/page-"));
	try {
		const original = startBlock("cold", "body");
		state.accept(original);
		state.accept({ type: "message_status", messageId: "cold", persistence: "pending" });
		await state.idle();
		const before = state.freeze();
		const order: string[] = [];
		const status = state.applyCold({ type: "message_status", messageId: "cold", persistence: "appended" });
		await hold.entered;
		state.accept(startBlock("active", "a"));
		state.accept({ type: "block_delta", messageId: "active", contentIndex: 0, offset: 1, text: "b" });
		const during = state.freeze();
		const remove = state.applyCold({ type: "message_remove", messageId: "cold" }).then((outcome) => {
			order.push("remove");
			state.accept(startBlock("cold", "new"));
			state.accept({ type: "message_status", messageId: "cold", persistence: "pending" });
			return outcome;
		});
		const stale = state.applyCold({ type: "message_status", messageId: "cold", persistence: "failed" });
		const observed = status.then((outcome) => {
			order.push("status");
			return outcome;
		});
		for (const type of ["block_delta", "block_replace"] as const)
			expect(() => state.accept({ type, messageId: "cold", contentIndex: 0, offset: 0, text: "bad" })).toThrow(
				expect.objectContaining({ reason: "unknown_block" }),
			);
		expect(() => state.accept({ ...startBlock("cold", "duplicate"), firstOrdinal: original.firstOrdinal })).toThrow(
			expect.objectContaining({ reason: "duplicate_or_stale_start" }),
		);
		expect(state.acceptedSequence).toBe(4);
		hold.release();
		expect(await observed).toEqual({ kind: "applied", afterSequence: 2 });
		expect(await remove).toEqual({ kind: "applied", afterSequence: 4 });
		expect(await stale).toEqual({ kind: "rejected", reason: "unknown_message", afterSequence: 4 });
		expect(order).toEqual(["status", "remove"]);
		expect(state.acceptedSequence).toBe(6);
		const after = state.freeze();
		try {
			expect((await state.read(before)).messages.map((m) => [m.messageId, m.persistence, m.blocks[0].text])).toEqual(
				[["cold", "pending", "body"]],
			);
			expect((await state.read(during)).messages.map((m) => [m.messageId, m.persistence, m.blocks[0].text])).toEqual(
				[
					["cold", "pending", "body"],
					["active", undefined, "ab"],
				],
			);
			expect((await state.read(after)).messages.map((m) => [m.messageId, m.persistence, m.blocks[0].text])).toEqual([
				["cold", "pending", "new"],
				["active", undefined, "ab"],
			]);
		} finally {
			for (const cut of [before, during, after]) state.release(cut);
		}
	} finally {
		hold.release();
		await state.retire();
		await root.cleanup();
	}
});

it("bounds pending cold work and preserves the root on read failure", async () => {
	const root = await spoolRoot();
	const io = controlledIo();
	const state = new CompactSessionState({ dir: root.dir, io: io.io, compactAboveRows: 1 });
	const hold = io.hold("read", (path) => path.includes("/page-"));
	try {
		state.accept(startBlock("cold", "body"));
		state.accept({ type: "message_status", messageId: "cold", persistence: "pending" });
		await state.idle();
		const failed = state.applyCold({ type: "message_status", messageId: "cold", persistence: "failed" });
		await hold.entered;
		const queued = Array.from({ length: 127 }, () =>
			state.applyCold({
				type: "message_status",
				messageId: "cold",
				persistence: "appended",
			}),
		);
		expect(await state.applyCold({ type: "message_remove", messageId: "cold" })).toEqual({
			kind: "rejected",
			reason: "capacity",
			afterSequence: 2,
		});
		const cut = state.freeze();
		hold.fail(new Error("read unavailable"));
		expect(await failed).toMatchObject({ kind: "failed", afterSequence: 2 });
		expect((await Promise.all(queued)).every((result) => result.kind === "applied")).toBe(true);
		try {
			expect((await state.read(cut)).messages[0].persistence).toBe("pending");
		} finally {
			state.release(cut);
		}
		expect(state.acceptedSequence).toBe(2);
		expect(await state.applyCold({ type: "message_remove", messageId: "missing" })).toEqual({
			kind: "rejected",
			reason: "unknown_message",
			afterSequence: 2,
		});
	} finally {
		hold.release();
		await state.retire();
		await root.cleanup();
	}
});

it("joins a held cold read during retirement without publishing its mutation", async () => {
	const root = await spoolRoot();
	const io = controlledIo();
	const state = new CompactSessionState({ dir: root.dir, io: io.io, compactAboveRows: 1 });
	const hold = io.hold("read", (path) => path.includes("/page-"));
	try {
		state.accept(startBlock("cold", "body"));
		state.accept({ type: "message_status", messageId: "cold", persistence: "pending" });
		await state.idle();
		const operation = state.applyCold({ type: "message_remove", messageId: "cold" });
		await hold.entered;
		const retiring = state.retire();
		hold.release();
		expect(await operation).toEqual({ kind: "rejected", reason: "retired", afterSequence: 2 });
		await retiring;
		expect(state.acceptedSequence).toBe(2);
	} finally {
		hold.release();
		await state.retire();
		await root.cleanup();
	}
});

it("holds one override slot for 10,000 ordered updates to the same settled row", async () => {
	const root = await spoolRoot();
	const state = new CompactSessionState({ dir: root.dir });
	try {
		state.accept(startBlock("m1", "abc"));
		state.accept({ type: "message_status", messageId: "m1", persistence: "pending" });
		const resident = state.storageStatus().residentPayloadBytes;
		for (let i = 0; i < 10_000; i++) {
			const persistence = i % 2 === 0 ? "appended" : "failed";
			expect(await state.applyCold({ type: "message_status", messageId: "m1", persistence })).toMatchObject({
				kind: "applied",
			});
		}
		expect(state.acceptedSequence).toBe(2);
		expect(state.storageStatus()).toMatchObject({ overrideSlots: 1, residentPayloadBytes: resident });
		const cut = state.freeze();
		try {
			expect((await state.read(cut)).messages).toEqual([
				{ messageId: "m1", persistence: "failed", blocks: [{ contentIndex: 0, kind: "text", text: "abc" }] },
			]);
		} finally {
			state.release(cut);
		}
	} finally {
		await state.retire();
		await root.cleanup();
	}
});

it("rechecks retirement between a completed lookup and cold publication", async () => {
	const root = await spoolRoot();
	const state = new CompactSessionState({ dir: root.dir, compactAboveRows: 1 });
	let retiring: Promise<void> | undefined;
	const lookup = CompactContentIndex.prototype.lookup;
	const spy = vi.spyOn(CompactContentIndex.prototype, "lookup").mockImplementation(async function (
		this: CompactContentIndex<object>,
		cut,
		key,
	) {
		const row = await lookup.call(this, cut, key);
		retiring = state.retire();
		return row;
	});
	try {
		state.accept(startBlock("cold", "body"));
		state.accept({ type: "message_status", messageId: "cold", persistence: "pending" });
		await state.idle();
		expect(await state.applyCold({ type: "message_remove", messageId: "cold" })).toEqual({
			kind: "rejected",
			reason: "retired",
			afterSequence: 2,
		});
	} finally {
		spy.mockRestore();
		await retiring;
		await state.retire();
		await root.cleanup();
	}
});
