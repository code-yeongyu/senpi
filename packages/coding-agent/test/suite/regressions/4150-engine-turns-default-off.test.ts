import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";

import { ENGINE_TURN_LIMIT_ENTRY_TYPE } from "../../../src/core/engine-turn-limit.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { createHarness, type Harness, type HarnessOptions } from "../harness.ts";

const AUTO_TURN_ATTEMPTS = 160;

function workingContinuation(attempts: number) {
	return (pi: ExtensionAPI): void => {
		let sent = 0;
		pi.registerTool({
			name: "do_work",
			label: "Do work",
			description: "One unit of real work",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
		});
		pi.on("agent_settled", () => {
			if (sent >= attempts) return;
			sent += 1;
			pi.sendMessage(
				{ customType: "goal-continuation", content: "continue", display: false },
				{ triggerTurn: true },
			);
		});
	};
}

async function runOneMessage(options: HarnessOptions): Promise<Harness> {
	const harness = await createHarness({ ...options, extensionFactories: [workingContinuation(AUTO_TURN_ATTEMPTS)] });
	harness.setResponses(
		Array.from({ length: AUTO_TURN_ATTEMPTS + 1 }, (_, index) => [
			fauxAssistantMessage([fauxToolCall("do_work", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText(`progress ${index}`)]),
		]).flat(),
	);
	await harness.session.prompt("start");
	for (let pass = 0; pass < AUTO_TURN_ATTEMPTS * 6; pass++) {
		await harness.session.waitForIdle();
		await Promise.resolve();
	}
	return harness;
}

function customEntries(harness: Harness, customType: string): unknown[] {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === customType);
}

describe("senpi#4150 the per-message engine turn cap is off by default", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("defaults maxPerUserInput to 0 and keeps the other engine-turn limits", async () => {
		harness = await createHarness();

		expect(harness.settingsManager.getEngineTurnSettings()).toEqual({
			maxPerUserInput: 0,
			maxPerResumeWindow: 8,
			maxToolFreePerMinute: 12,
		});
	});

	it("lets one user message drive more than 150 engine turns when nothing is configured", async () => {
		// given no engineTurns setting and a source whose every turn does real work
		// when one user message starts it
		harness = await runOneMessage({});

		// then every continuation ran and nothing paused
		expect(customEntries(harness, "engine-turn-start")).toHaveLength(AUTO_TURN_ATTEMPTS);
		expect(customEntries(harness, ENGINE_TURN_LIMIT_ENTRY_TYPE)).toEqual([]);
		expect(customEntries(harness, "engine-paused")).toEqual([]);
	});

	it("still pauses at an explicitly configured maxPerUserInput of 150", async () => {
		// given the cap set explicitly to the old default
		// when one user message starts the same source
		harness = await runOneMessage({ settings: { engineTurns: { maxPerUserInput: 150 } } });

		// then the engine stopped after 150 of its own turns and recorded why
		expect(customEntries(harness, "engine-turn-start")).toHaveLength(150);
		expect(customEntries(harness, ENGINE_TURN_LIMIT_ENTRY_TYPE)).toEqual([
			expect.objectContaining({ data: expect.objectContaining({ reason: "per-user-input", sinceUserInput: 150 }) }),
		]);
	});
});
