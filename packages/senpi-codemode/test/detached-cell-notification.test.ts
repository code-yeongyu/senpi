import { describe, expect, it } from "vitest";
import type { EvalDetachedCellSnapshot } from "../src/tool/detached-cell-manager.ts";
import { buildDetachedCellNotification, memoryStateNote } from "../src/tool/detached-cell-notification.ts";
import { interruptionStateNote, unknownInterruptionStateNote } from "../src/tool/interrupt-note.ts";
import type { EvalLanguage, EvalMemoryDetails } from "../src/tool/types.ts";

function cancelledSnapshot(
	language: EvalLanguage,
	stateRetained: boolean | undefined,
	interruptNote?: string,
): EvalDetachedCellSnapshot {
	return {
		cellId: `cancelled-${language}`,
		language,
		startedAtMs: 0,
		state: "cancelled",
		outputTail: "",
		stateRetained,
		...(interruptNote === undefined ? {} : { interruptNote }),
		result: {
			content: [{ type: "text", text: "buffered tail" }],
			details: { language, durationMs: 0, toolCalls: [], truncated: false },
		},
	};
}

describe("detached cell notification state note", () => {
	it("Given a cancelled js cell whose worker survived the interrupt when the notification is built then it reports the retained state", async () => {
		const notification = await buildDetachedCellNotification(cancelledSnapshot("js", true));

		expect(notification.content).toContain(interruptionStateNote("js", true));
	});

	it("Given a cancelled js cell whose worker was restarted when the notification is built then it reports the lost state", async () => {
		const notification = await buildDetachedCellNotification(cancelledSnapshot("js", false));

		expect(notification.content).toContain(interruptionStateNote("js", false));
	});

	it("Given a cancelled py cell whose kernel was restarted when the notification is built then it does not claim the variables survived", async () => {
		const notification = await buildDetachedCellNotification(cancelledSnapshot("py", false));

		expect(notification.content).toContain(interruptionStateNote("py", false));
	});

	it("Given a cancelled js cell whose kernel supplied an interrupt note when the notification is built then the note follows the state", async () => {
		const notification = await buildDetachedCellNotification(
			cancelledSnapshot("js", false, "A synchronous call is blocking the old worker.\n"),
		);

		expect(notification.content).toContain(
			`${interruptionStateNote("js", false)} A synchronous call is blocking the old worker.`,
		);
	});

	it("Given a cancelled cell with no interrupt outcome when the notification is built then it says the outcome is unknown", async () => {
		const notification = await buildDetachedCellNotification(cancelledSnapshot("js", undefined));

		expect(notification.content).toContain(unknownInterruptionStateNote("js"));
	});

	it.each([
		{ kernelState: "lost", says: "every global is lost" },
		{ kernelState: "restarted", says: "globals from earlier cells are gone" },
		{ kernelState: "not-run", says: "never ran and changed no kernel state" },
	] as const)(
		"Given a failed py cell whose kernel died ($kernelState) when the notification is built then it does not claim the variables survived",
		async ({ kernelState, says }) => {
			const snapshot: EvalDetachedCellSnapshot = {
				cellId: `death-${kernelState}`,
				language: "py",
				startedAtMs: 0,
				state: "failed",
				outputTail: "",
				stateRetained: undefined,
				result: {
					content: [{ type: "text", text: "Python kernel died" }],
					details: { language: "py", durationMs: 0, toolCalls: [], truncated: false, kernelState },
				},
			};

			const notification = await buildDetachedCellNotification(snapshot);

			expect(notification.content).toContain(says);
			expect(notification.content).not.toContain(memoryStateNote(undefined));
		},
	);

	it.each([
		{ name: "over its ceiling", memory: { liveBytes: 1, measure: "heap", overCeiling: true } },
		{ name: "just recycled", memory: { liveBytes: 1, measure: "heap", recycled: true } },
	] satisfies readonly { name: string; memory: EvalMemoryDetails }[])(
		"Given a completed cell whose kernel is $name when the notification is built then it does not claim the old globals survive",
		async ({ memory }) => {
			const snapshot: EvalDetachedCellSnapshot = {
				cellId: "memory-js",
				language: "js",
				startedAtMs: 0,
				state: "completed",
				outputTail: "",
				stateRetained: true,
				result: {
					content: [{ type: "text", text: "done" }],
					details: { language: "js", durationMs: 0, toolCalls: [], truncated: false, memory },
				},
			};

			const notification = await buildDetachedCellNotification(snapshot);

			expect(notification.content).toContain(memoryStateNote(memory));
			expect(notification.content).not.toContain(memoryStateNote(undefined));
		},
	);
});
