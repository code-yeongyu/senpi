import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "./harness.ts";

// senpi#3717 review (#3722 MEDIUM): a turn whose automatic retry is cancelled or declined ends without the
// retried turn's agent_end, so the barrier must clear on that exit or it holds the next turns' write tools.

const BARRIER = { id: "retry-turn", deadlineMs: 600_000 } as const;

function mutateTool(ran: string[]) {
	return (pi: ExtensionAPI): void => {
		pi.registerTool({
			name: "mutate",
			label: "mutate",
			description: "Changes the workspace.",
			parameters: Type.Object({}),
			execute: async () => {
				ran.push("mutate");
				return { content: [{ type: "text", text: "mutated" }], details: {} };
			},
		});
	};
}

describe("session tool barrier across retry exits", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(retry: Record<string, unknown>, ran: string[]): Promise<Harness> {
		const harness = await createHarness({
			initialActiveToolNames: [],
			settings: { retry: { enabled: true, maxRetries: 3, ...retry } },
			extensionFactories: [mutateTool(ran)],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		return harness;
	}

	async function expectNextTurnUnheld(harness: Harness, ran: string[]): Promise<void> {
		expect(harness.session.releaseToolBarrier(BARRIER.id)).toBe(false);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mutate", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("next");
		expect(ran).toEqual(["mutate"]);
		expect(harness.eventsOfType("tool_barrier_waiting")).toEqual([]);
	}

	it("clears the barrier when the retry is cancelled during its backoff", async () => {
		const ran: string[] = [];
		const harness = await setup({ baseDelayMs: 60_000 }, ran);
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") harness.session.abortRetry();
		});
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })]);

		await harness.session.prompt("go", { toolBarrier: BARRIER });
		await harness.session.waitForIdle();

		expect(harness.eventsOfType("auto_retry_end").map((event) => event.finalError)).toEqual(["Retry cancelled"]);
		await expectNextTurnUnheld(harness, ran);
	});

	it("leaves no barrier after a retry declined for a provider delay above the maximum", async () => {
		const ran: string[] = [];
		const harness = await setup(
			{ baseDelayMs: 1, provider: { maxRetryDelayMs: 50 }, fallbackChains: { "*": [] } },
			ran,
		);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error (retry-after-ms: 75)" }),
		]);

		await harness.session.prompt("go", { toolBarrier: BARRIER });
		await harness.session.waitForIdle();

		expect(harness.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual([false]);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.finalError)).toEqual([
			"Provider requested retry delay 75ms, exceeding configured maximum 50ms",
		]);
		await expectNextTurnUnheld(harness, ran);
	});
});
