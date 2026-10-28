import { expect, it } from "vitest";
import { CompactSessionState } from "../../../src/modes/rpc/compact-session-state.ts";
import { controlledIo, type IoHold, spoolRoot } from "../compact-storage-support.ts";

// senpi#4272 / RULING-40: the producer binds every block to its message's first ordinal.
const start = (ordinal: number, firstOrdinal: number, messageId = "message", contentIndex = ordinal) => ({
	type: "block_start" as const,
	epoch: "A",
	ordinal,
	firstOrdinal,
	messageId,
	contentIndex,
	kind: "text" as const,
	seed: "body",
	coveredCodeUnits: 0,
});

it.each([undefined, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 2])(
	"rejects invalid first ordinal %s without consuming identity",
	async (firstOrdinal) => {
		const root = await spoolRoot();
		const state = new CompactSessionState({ dir: root.dir });
		try {
			expect(() => Reflect.apply(state.accept, state, [{ ...start(1, 1), firstOrdinal }])).toThrow(
				expect.objectContaining({ reason: "invalid_start_identity" }),
			);
			expect(state.accept(start(1, 1))).toBe(1);
		} finally {
			await state.retire();
			await root.cleanup();
		}
	},
);

it.each([
	{ firstOrdinal: 1, epoch: "A" },
	{ firstOrdinal: 0, epoch: "B" },
])("rejects an inconsistent live binding $epoch/$firstOrdinal atomically", async (binding) => {
	const root = await spoolRoot();
	const state = new CompactSessionState({ dir: root.dir });
	try {
		state.accept(start(0, 0));
		expect(() => state.accept({ ...start(1, 0), ...binding })).toThrow(
			expect.objectContaining({ reason: "invalid_start_identity" }),
		);
		expect(state.accept(start(1, 0))).toBe(2);
		const cut = state.freeze();
		try {
			expect((await state.read(cut)).messages[0].blocks.map((block) => block.contentIndex)).toEqual([0, 1]);
		} finally {
			state.release(cut);
		}
	} finally {
		await state.retire();
		await root.cleanup();
	}
});

it("keeps exact duplicate rejection across every held page-out and cold-read step", async () => {
	const root = await spoolRoot();
	const io = controlledIo();
	const state = new CompactSessionState({ dir: root.dir, io: io.io, compactAboveRows: 1 });
	const write = io.hold("write", (path) => path.includes("/page-"));
	let read: IoHold | undefined;
	let handoff: IoHold | undefined;
	const duplicate = () =>
		expect(() => state.accept(start(1, 0))).toThrow(expect.objectContaining({ reason: "duplicate_or_stale_start" }));
	try {
		state.accept(start(0, 0));
		state.accept({ type: "message_status", messageId: "message", persistence: "pending" });
		duplicate();
		await write.entered;
		duplicate();
		// The pending overlay remains readable before the committed representation replaces it.
		expect(
			await state.applyCold({ type: "message_status", messageId: "message", persistence: "appended" }),
		).toMatchObject({ kind: "applied" });
		duplicate();
		handoff = io.hold("write", (path) => path.includes("/value-"));
		write.release();
		await handoff.entered;
		// The row page is committed, but its replacement navigation root is not published yet.
		duplicate();
		expect(
			await state.applyCold({ type: "message_status", messageId: "message", persistence: "appended" }),
		).toMatchObject({ kind: "applied" });
		duplicate();
		handoff.release();
		await state.idle();
		duplicate();
		read = io.hold("read", (path) => path.includes("/page-"));
		const cold = state.applyCold({ type: "message_status", messageId: "message", persistence: "failed" });
		await read.entered;
		duplicate();
		expect(state.accept(start(1, 1, "fresh"))).toBe(3);
		read.release();
		expect(await cold).toMatchObject({ kind: "applied" });
		expect(() => state.accept(start(2, 0))).toThrow(expect.objectContaining({ reason: "duplicate_or_stale_start" }));
		const cut = state.freeze();
		try {
			expect((await state.read(cut)).messages.find((message) => message.messageId === "message")?.persistence).toBe(
				"failed",
			);
		} finally {
			state.release(cut);
		}
	} finally {
		write.release();
		handoff?.release();
		read?.release();
		await state.retire();
		await root.cleanup();
	}
});

it("releases settled membership instead of retaining a catalog after 10,000 messages", async () => {
	const root = await spoolRoot();
	// Keep the real codec, compactor and ownership graph; only the file bytes live in this backing store.
	const files = new Map<string, Buffer>();
	const state = new CompactSessionState({
		dir: root.dir,
		compactAboveRows: 100,
		io: {
			async writeFile(path, data) {
				files.set(path, Buffer.from(data));
			},
			async readFile(path, range) {
				const data = files.get(path);
				if (!data) throw Object.assign(new Error("missing backing file"), { code: "ENOENT" });
				return Buffer.from(range ? data.subarray(range.offset, range.offset + range.length) : data);
			},
			async unlink(path) {
				files.delete(path);
			},
		},
	});
	try {
		state.accept(start(0, 0, "live"));
		for (let ordinal = 1; ordinal <= 10_000; ordinal++) {
			const messageId = `settled-${ordinal}`;
			state.accept(start(ordinal, ordinal, messageId));
			state.accept({ type: "message_status", messageId, persistence: "appended" });
			if (ordinal % 100 === 0) {
				await state.idle();
				expect(state.storageStatus().residentIndexNodes).toBe(0);
				expect(state.storageStatus().structuredBytes.resident).toBe(0);
				expect(state["identity"]["live"].size).toBe(1);
			}
		}
		expect(state.storageStatus().baseRows).toBe(10_000);
		expect(state.accept(start(10_001, 0, "live"))).toBe(20_002);
	} finally {
		await state.retire();
		await root.cleanup();
	}
}, 120_000);
