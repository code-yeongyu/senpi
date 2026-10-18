import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { WAKE_SOURCE_STATE_EVENT } from "../../../src/core/extensions/builtin/monitor-state-event.ts";
import { createHarness, type Harness } from "../harness.ts";

/**
 * Settlement-time readers gate work on `ctx.isIdle()`: config-reload flushes a pending reload
 * on `agent_settled` only when idle, and the loop builtin drains deferred ticks there under the
 * same guard. A live wake source (monitor, background task, DAG run) describes work that will
 * wake the session later; it is not a running turn, so it must not make those readers wait.
 * Surfaces that must not announce a stop while such work is live (the Stop hook, the herdr
 * reporter) read `wake_source_state` themselves instead.
 */
describe("agent_settled keeps reporting idle to extensions while a wake source is live", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("reads idle true at settlement with and without a live wake source", async () => {
		const settledIdleStates: boolean[] = [];
		let wakeSourceOpened = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_end", () => {
						if (wakeSourceOpened) {
							pi.events.emit(WAKE_SOURCE_STATE_EVENT, { source: "terminal-monitors", activeCount: 0 });
							return;
						}
						wakeSourceOpened = true;
						pi.events.emit(WAKE_SOURCE_STATE_EVENT, { source: "terminal-monitors", activeCount: 1 });
					});
					pi.on("agent_settled", (_event, ctx) => {
						settledIdleStates.push(ctx.isIdle());
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		await harness.session.prompt("turn one");
		expect(harness.session.isIdle).toBe(true);
		await harness.session.prompt("turn two");

		expect(harness.eventsOfType("agent_settled")).toHaveLength(2);
		expect(settledIdleStates).toEqual([true, true]);
	});
});
