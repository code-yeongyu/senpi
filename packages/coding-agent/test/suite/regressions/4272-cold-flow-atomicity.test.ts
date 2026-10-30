import { expect, it } from "vitest";
import { CompactSessionState } from "../../../src/modes/rpc/compact-session-state.ts";
import { controlledIo, spoolRoot, startBlock } from "../compact-storage-support.ts";
import { assistant } from "./4272-seeded-json-fixtures.ts";

const edited = () => {
	const message = assistant();
	message.content.push({ type: "text", text: "after" });
	return message;
};

// #4425 LOW 1: a flow publishes once, so a reader's cut holds all of it or none of it.
it("T6 a branch flow is atomic to a cut frozen while its later step is still reading", async () => {
	const root = await spoolRoot();
	const io = controlledIo();
	const state = new CompactSessionState({ dir: root.dir, io: io.io, compactAboveRows: 1 });
	try {
		for (const id of ["a", "b"]) {
			state.accept(startBlock(id, id));
			state.accept({ type: "message_status", messageId: id, persistence: "appended" });
		}
		await state.idle();
		const first = io.hold("read", (path) => path.includes("/page-"));
		const second = io.hold("read", (path) => path.includes("/page-"));
		const branch = state.applyColdFlow({
			type: "branch",
			removed: ["a"],
			installed: [{ messageId: "b", message: edited(), persistence: "appended" }],
		});
		await first.entered;
		first.release();
		await second.entered;
		const mid = state.freeze();
		second.release();
		const applied = { kind: "applied", afterSequence: 4 };
		expect(await branch).toEqual([applied, applied]);
		const after = state.freeze();
		try {
			expect((await state.read(mid)).messages).toMatchObject([
				{ messageId: "a", blocks: [{ text: "a" }] },
				{ messageId: "b", blocks: [{ text: "b" }] },
			]);
			expect((await state.read(after)).messages).toMatchObject([{ messageId: "b", blocks: [{ text: "after" }] }]);
		} finally {
			state.release(mid);
			state.release(after);
		}
	} finally {
		await state.retire();
		await root.cleanup();
	}
});

// #4425 LOW 2: like run, a flow answers active_message before capacity, and an empty flow takes no slot.
it("T6 a flow answers active_message before capacity and an empty flow consumes no slot", async () => {
	const root = await spoolRoot();
	const io = controlledIo();
	const state = new CompactSessionState({ dir: root.dir, io: io.io, compactAboveRows: 1 });
	const hold = io.hold("read", (path) => path.includes("/page-"));
	try {
		state.accept(startBlock("a", "a"));
		state.accept({ type: "message_status", messageId: "a", persistence: "pending" });
		state.accept(startBlock("live", "x"));
		await state.idle();
		const first = state.applyCold({ type: "message_status", messageId: "a", persistence: "appended" });
		await hold.entered;
		const queued = Array.from({ length: 126 }, () =>
			state.applyCold({ type: "message_status", messageId: "a", persistence: "failed" }),
		);
		const empty = state.applyColdFlow({ type: "compaction", removed: [] });
		const last = state.applyCold({ type: "message_status", messageId: "a", persistence: "appended" });
		const active = { kind: "rejected", reason: "active_message", afterSequence: 3 };
		expect(await state.applyColdFlow({ type: "context_edit_removal", messageId: "live" })).toEqual([active]);
		expect(await state.applyColdFlow({ type: "compaction", removed: ["live", "a"] })).toEqual([
			active,
			{ kind: "rejected", reason: "capacity", afterSequence: 3 },
		]);
		hold.release();
		await first;
		await Promise.all(queued);
		expect(await empty).toEqual([]);
		expect(await last).toEqual({ kind: "applied", afterSequence: 3 });
	} finally {
		hold.release();
		await state.retire();
		await root.cleanup();
	}
});
