import { describe, expect, it } from "vitest";
import { SessionEventWriter } from "../src/modes/rpc/session-event-writer.ts";

const tick = () => Promise.resolve();

async function microtasks(count: number): Promise<void> {
	for (let index = 0; index < count; index++) await tick();
}

describe("SessionEventWriter retained-queue drain", () => {
	// Sweeping the offset asserts the invariant (no arrival is ever stranded)
	// rather than one hardcoded hop count, so the pin survives refactors that
	// shift how many microtasks the drain takes to settle. Deliberately no
	// flush() after the arrival: a trailing flush would rescue the stranded
	// record and mask the defect.
	it("delivers a record enqueued at every microtask offset around drain settling", async () => {
		for (let offset = 0; offset <= 12; offset++) {
			const output: string[] = [];
			const writer = new SessionEventWriter((chunk) => output.push(chunk));

			writer.enqueue("s", { type: "response", id: "first" });
			await microtasks(offset);
			writer.enqueue("s", { type: "message_update", id: "second" });
			await microtasks(40);

			expect(
				output.some((line) => line.includes('"second"')),
				`record enqueued at microtask offset ${offset} was stranded`,
			).toBe(true);
		}
	});
});
