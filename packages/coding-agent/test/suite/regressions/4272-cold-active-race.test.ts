import { expect, it, vi } from "vitest";
import { CompactSessionState } from "../../../src/modes/rpc/compact-session-state.ts";
import { controlledIo, spoolRoot, startBlock } from "../compact-storage-support.ts";

// senpi#4272 / RULING-33: an active target belongs exclusively to synchronous acceptance.
it.each(
	(["message_status", "message_remove"] as const).flatMap((type) =>
		(["enqueue", "lookup", "lookup-settled", "publication", "publication-settled"] as const).map((step) => ({
			type,
			step,
		})),
	),
)("rejects active $type at $step", async ({ type, step }) => {
	const root = await spoolRoot();
	const io = controlledIo();
	const state = new CompactSessionState({ dir: root.dir, io: io.io, compactAboveRows: 1 });
	const gate = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const settled = state["settled"];
	const lookup = settled.lookup.bind(settled);
	const spy = vi.spyOn(settled, "lookup").mockImplementation(async (cut, key) => {
		if (key === "target" && step.startsWith("publication")) {
			const row = await lookup(cut, key);
			entered.resolve();
			await gate.promise;
			return row;
		}
		return lookup(cut, key);
	});
	const hold = io.hold("read", (path) => path.includes("/page-"));
	try {
		state.accept(startBlock("blocker", "body"));
		state.accept({ type: "message_status", messageId: "blocker", persistence: "pending" });
		if (step !== "enqueue") {
			state.accept(startBlock("target", "old"));
			state.accept({ type: "message_status", messageId: "target", persistence: "pending" });
		}
		await state.idle();
		const blocker = state.applyCold({ type: "message_status", messageId: "blocker", persistence: "appended" });
		await hold.entered;
		if (step === "enqueue") state.accept(startBlock("target", "live"));
		const sequence = state.acceptedSequence;
		const cold = state.applyCold({ type, messageId: "target", persistence: "failed" });
		let followup: ReturnType<typeof state.applyCold> | undefined;
		if (step === "enqueue") {
			// Admission rejects immediately, even while unrelated cold work is blocked.
			expect(await cold).toEqual({ kind: "rejected", reason: "active_message", afterSequence: sequence });
		} else if (step.startsWith("lookup")) state.accept(startBlock("target", "live"));
		if (step === "lookup-settled") {
			state.accept({ type: "message_status", messageId: "target", persistence: "appended" });
			followup = state.applyCold({ type: "message_status", messageId: "target", persistence: "appended" });
			expect(spy.mock.calls.some(([, key]) => key === "target")).toBe(false);
		}
		hold.release();
		if (step.startsWith("publication")) {
			await entered.promise;
			state.accept(startBlock("target", "live"));
			if (step === "publication-settled") {
				state.accept({ type: "message_status", messageId: "target", persistence: "appended" });
				followup = state.applyCold({ type: "message_status", messageId: "target", persistence: "appended" });
			}
			gate.resolve();
		}
		expect(await blocker).toMatchObject({ kind: "applied" });
		expect(await cold).toEqual({ kind: "rejected", reason: "active_message", afterSequence: sequence });
		if (followup) expect(await followup).toEqual({ kind: "applied", afterSequence: sequence + 2 });
		const cut = state.freeze();
		try {
			const messages = (await state.read(cut)).messages.filter((m) => m.messageId === "target");
			expect(messages.some((m) => m.persistence === "failed")).toBe(false);
			expect(messages.some((m) => m.blocks[0].text === "live")).toBe(true);
		} finally {
			state.release(cut);
		}
	} finally {
		gate.resolve();
		hold.release();
		spy.mockRestore();
		await state.retire();
		await root.cleanup();
	}
});
