import { describe, expect, it } from "vitest";
import type { EvalDetachedCellSnapshot } from "../src/tool/detached-cell-manager.ts";
import { buildDetachedCellNotification } from "../src/tool/detached-cell-notification.ts";
import { interruptionStateNote, unknownInterruptionStateNote } from "../src/tool/interrupt-note.ts";
import type { EvalLanguage } from "../src/tool/types.ts";

function cancelledSnapshot(
	language: EvalLanguage,
	stateRetained: boolean | undefined,
	interruptNote?: string,
): EvalDetachedCellSnapshot {
	return {
		cellId: `cancelled-${language}`,
		language,
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
		const notification = await buildDetachedCellNotification(cancelledSnapshot("js", true), undefined);

		expect(notification.content).toContain(interruptionStateNote("js", true));
	});

	it("Given a cancelled js cell whose worker was restarted when the notification is built then it reports the lost state", async () => {
		const notification = await buildDetachedCellNotification(cancelledSnapshot("js", false), undefined);

		expect(notification.content).toContain(interruptionStateNote("js", false));
	});

	it("Given a cancelled py cell whose kernel was restarted when the notification is built then it does not claim the variables survived", async () => {
		const notification = await buildDetachedCellNotification(cancelledSnapshot("py", false), undefined);

		expect(notification.content).toContain(interruptionStateNote("py", false));
	});

	it("Given a cancelled js cell whose kernel supplied an interrupt note when the notification is built then the note follows the state", async () => {
		const notification = await buildDetachedCellNotification(
			cancelledSnapshot("js", false, "A synchronous call is blocking the old worker.\n"),
			undefined,
		);

		expect(notification.content).toContain(
			`${interruptionStateNote("js", false)} A synchronous call is blocking the old worker.`,
		);
	});

	it("Given a cancelled cell with no interrupt outcome when the notification is built then it says the outcome is unknown", async () => {
		const notification = await buildDetachedCellNotification(cancelledSnapshot("js", undefined), undefined);

		expect(notification.content).toContain(unknownInterruptionStateNote("js"));
	});
});
