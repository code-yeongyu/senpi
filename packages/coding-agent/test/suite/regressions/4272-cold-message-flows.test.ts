import { expect, it } from "vitest";
import { CompactSessionState } from "../../../src/modes/rpc/compact-session-state.ts";
import { controlledIo, spoolRoot, startBlock, startIdentity } from "../compact-storage-support.ts";
import { assistant } from "./4272-seeded-json-fixtures.ts";

// senpi#4272 / T6 cold flows (RULING-33 condition 2): settled targets change only after acceptance, with typed outcomes.
const edited = () => {
	const message = assistant();
	message.content.push({ type: "text", text: "after" });
	return message;
};

it("T6 edits a settled message after acceptance, keeping its persistence and every held cut", async () => {
	const root = await spoolRoot();
	const io = controlledIo();
	const state = new CompactSessionState({ dir: root.dir, io: io.io, compactAboveRows: 1 });
	try {
		state.accept(startBlock("old", "before"));
		state.accept({ type: "message_status", messageId: "old", persistence: "pending" });
		await state.idle();
		expect(
			await state.applyCold({ type: "message_status", messageId: "old", persistence: "appended" }),
		).toMatchObject({
			kind: "applied",
		});
		const before = state.freeze();
		const hold = io.hold("read", (path) => path.includes("/page-"));
		const edit = state.applyCold({ type: "message_replace", messageId: "old", message: edited() });
		await hold.entered;
		state.accept(startBlock("live", "a"));
		hold.release();
		expect(await edit).toEqual({ kind: "applied", afterSequence: 2 });
		expect(await state.applyCold({ type: "message_replace", messageId: "missing", message: edited() })).toEqual({
			kind: "rejected",
			reason: "unknown_message",
			afterSequence: 3,
		});
		expect(await state.applyCold({ type: "message_replace", messageId: "live", message: edited() })).toEqual({
			kind: "rejected",
			reason: "active_message",
			afterSequence: 3,
		});
		expect(state.acceptedSequence).toBe(3);
		const after = state.freeze();
		try {
			expect((await state.read(before)).messages).toEqual([
				{ messageId: "old", persistence: "appended", blocks: [{ contentIndex: 0, kind: "text", text: "before" }] },
			]);
			expect((await state.read(after)).messages).toMatchObject([
				{
					messageId: "old",
					persistence: "appended",
					blocks: [{ contentIndex: 0, kind: "text", text: "after" }],
					message: { role: "assistant", model: "fixture", content: [{ type: "text", text: "after" }] },
				},
				{ messageId: "live", persistence: undefined, blocks: [{ text: "a" }] },
			]);
		} finally {
			state.release(before);
			state.release(after);
		}
		state.accept({
			type: "seeded_message",
			...startIdentity(),
			messageId: "seeded",
			record: { type: "message_end", message: { role: "user", content: "hi", timestamp: 1 } },
			correlation: { clientMessageId: "client-1" },
		});
		expect(await state.applyCold({ type: "message_replace", messageId: "seeded", message: edited() })).toMatchObject({
			kind: "applied",
		});
		const edit2 = state.freeze();
		try {
			expect((await state.read(edit2)).messages.find((message) => message.messageId === "seeded")).toMatchObject({
				persistence: "pending",
				correlation: { clientMessageId: "client-1" },
				message: { role: "assistant", content: [{ type: "text", text: "after" }] },
			});
		} finally {
			state.release(edit2);
		}
	} finally {
		await state.retire();
		await root.cleanup();
	}
});

it("T6 maps user delete, compaction removal and branch replacement to ordered typed outcomes", async () => {
	const root = await spoolRoot();
	const state = new CompactSessionState({ dir: root.dir, compactAboveRows: 1 });
	try {
		for (const id of ["a", "b", "c"]) {
			state.accept(startBlock(id, id));
			state.accept({ type: "message_status", messageId: id, persistence: "appended" });
		}
		state.accept(startBlock("live", "x"));
		await state.idle();
		const before = state.freeze();
		const compaction = state.applyColdFlow({ type: "compaction", removed: ["a", "live", "missing"] });
		const branch = state.applyColdFlow({
			type: "branch",
			removed: ["b"],
			installed: [{ messageId: "d", message: edited(), persistence: "appended" }],
		});
		const remove = state.applyColdFlow({ type: "user_delete", messageId: "c" });
		const applied = { kind: "applied", afterSequence: 7 };
		expect(await compaction).toEqual([
			applied,
			{ kind: "rejected", reason: "active_message", afterSequence: 7 },
			{ kind: "rejected", reason: "unknown_message", afterSequence: 7 },
		]);
		expect(await branch).toEqual([applied, applied]);
		expect(await remove).toEqual([applied]);
		expect(state.acceptedSequence).toBe(7);
		const after = state.freeze();
		try {
			expect((await state.read(before)).messages.map((message) => message.messageId)).toEqual([
				"a",
				"b",
				"c",
				"live",
			]);
			expect((await state.read(after)).messages).toMatchObject([
				{ messageId: "d", persistence: "appended", blocks: [{ text: "after" }], message: { model: "fixture" } },
				{ messageId: "live", persistence: undefined },
			]);
		} finally {
			state.release(before);
			state.release(after);
		}
	} finally {
		await state.retire();
		await root.cleanup();
	}
});

it("T6 runs a large flow as one ordered unit holding a single capacity slot", async () => {
	const root = await spoolRoot();
	const io = controlledIo();
	const state = new CompactSessionState({ dir: root.dir, io: io.io, compactAboveRows: 1 });
	const hold = io.hold("read", (path) => path.includes("/page-"));
	try {
		state.accept(startBlock("a", "a"));
		state.accept({ type: "message_status", messageId: "a", persistence: "pending" });
		await state.idle();
		const first = state.applyCold({ type: "message_status", messageId: "a", persistence: "appended" });
		await hold.entered;
		const queued = Array.from({ length: 126 }, () =>
			state.applyCold({ type: "message_status", messageId: "a", persistence: "failed" }),
		);
		const removed = Array.from({ length: 200 }, (_, index) => `m${index}`);
		const flow = state.applyColdFlow({ type: "compaction", removed });
		expect(await state.applyCold({ type: "message_remove", messageId: "a" })).toEqual({
			kind: "rejected",
			reason: "capacity",
			afterSequence: 2,
		});
		hold.release();
		expect(await first).toMatchObject({ kind: "applied" });
		expect((await Promise.all(queued)).every((outcome) => outcome.kind === "applied")).toBe(true);
		const outcomes = await flow;
		expect(outcomes).toHaveLength(200);
		expect(outcomes.every((outcome) => outcome.kind === "rejected" && outcome.reason === "unknown_message")).toBe(
			true,
		);
	} finally {
		hold.release();
		await state.retire();
		await root.cleanup();
	}
});

it.each(["start_then_end", "end_only"] as const)(
	"T6 a seeded_message incarnation (%s) voids cold work queued while its key was settled",
	async (shape) => {
		const root = await spoolRoot();
		const io = controlledIo();
		const state = new CompactSessionState({ dir: root.dir, io: io.io, compactAboveRows: 1 });
		const user = (content: string) => ({ role: "user" as const, content, timestamp: 1 });
		const seeded = (
			record: { type: "message_start" | "message_end"; message: ReturnType<typeof user> },
			id = startIdentity(),
		) => state.accept({ type: "seeded_message", ...id, messageId: "target", record });
		try {
			state.accept(startBlock("blocker", "body"));
			state.accept({ type: "message_status", messageId: "blocker", persistence: "pending" });
			seeded({ type: "message_end", message: user("old") });
			await state.idle();
			const hold = io.hold("read", (path) => path.includes("/page-"));
			const blocker = state.applyCold({ type: "message_status", messageId: "blocker", persistence: "appended" });
			await hold.entered;
			const sequence = state.acceptedSequence;
			const stale = state.applyCold({ type: "message_status", messageId: "target", persistence: "failed" });
			if (shape === "start_then_end") {
				const id = startIdentity();
				seeded({ type: "message_start", message: user("new") }, id);
				seeded({ type: "message_end", message: user("new") }, startIdentity(id.firstOrdinal));
			} else seeded({ type: "message_end", message: user("new") });
			hold.release();
			expect(await blocker).toMatchObject({ kind: "applied" });
			expect(await stale).toEqual({ kind: "rejected", reason: "active_message", afterSequence: sequence });
			const cut = state.freeze();
			try {
				expect((await state.read(cut)).messages.find((message) => message.messageId === "target")).toMatchObject({
					persistence: "pending",
					message: { content: "new" },
				});
			} finally {
				state.release(cut);
			}
		} finally {
			await state.retire();
			await root.cleanup();
		}
	},
);
