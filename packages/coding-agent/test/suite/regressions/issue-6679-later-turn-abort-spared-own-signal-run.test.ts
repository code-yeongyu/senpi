import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../harness.ts";

// senpi#6679 review M2: a tool run's own signal must not be unioned with whichever turn is active when the
// call is made. A detached cell's background work (pi.executeTool with its own signal) outlives its turn;
// aborting a LATER turn must not kill those in-flight tool runs. Only the permission prompt is unioned.
describe("a later turn's abort does not end a call that runs under its own signal (senpi#6679 M2)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("a pi.executeTool run started during turn 2 survives turn 2's abort", async () => {
		const own = new AbortController();
		let api: ExtensionAPI | undefined;
		let slowAbortedByTurn = false;
		const waitStarted = Promise.withResolvers<void>();
		const nestedStarted = Promise.withResolvers<void>();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					api = pi;
					pi.registerTool({
						name: "wait",
						label: "Wait",
						description: "Blocks the turn until it is aborted",
						parameters: Type.Object({}),
						async execute(_toolCallId, _input, signal) {
							waitStarted.resolve();
							return await new Promise<{ content: { type: "text"; text: string }[]; details: unknown }>(
								(resolve) => {
									signal?.addEventListener("abort", () =>
										resolve({ content: [{ type: "text", text: "wait done" }], details: {} }),
									);
								},
							);
						},
					});
					pi.registerTool({
						name: "slow",
						label: "Slow",
						description: "Runs until its own signal aborts",
						parameters: Type.Object({}),
						async execute(_toolCallId, _input, signal) {
							nestedStarted.resolve();
							return await new Promise<{ content: { type: "text"; text: string }[]; details: unknown }>(
								(resolve) => {
									signal?.addEventListener("abort", () => {
										slowAbortedByTurn = signal.aborted && !own.signal.aborted;
										resolve({ content: [{ type: "text", text: "slow done" }], details: {} });
									});
								},
							);
						},
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("first done"),
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("first");
		const turn2 = harness.session.prompt("second");
		await waitStarted.promise;
		const nestedRun = api ? api.executeTool("slow", {}, { signal: own.signal }).catch(() => undefined) : undefined;
		await nestedStarted.promise;
		const aborted = harness.session.abort();
		await Promise.all([aborted, turn2.catch(() => undefined)]);

		expect(slowAbortedByTurn).toBe(false);

		own.abort();
		await nestedRun;
	});
});
