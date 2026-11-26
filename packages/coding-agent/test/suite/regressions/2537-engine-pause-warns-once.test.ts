import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { ENGINE_TURN_LIMIT_ENTRY_TYPE } from "../../../src/core/engine-turn-limit.ts";
import { createHarness, createTestUiContext, type Harness } from "../harness.ts";

const TOOL_FREE_BREAKER = 12;
const NOTICES_WHILE_PAUSED = 5;

describe("senpi#2537 a paused engine warns once, not once per refused event", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("shows the pause warning once while a stream of notices keeps arriving", async () => {
		harness = await createHarness();
		harness.setResponses(
			Array.from({ length: TOOL_FREE_BREAKER }, (_, index) => fauxAssistantMessage([fauxText(`noted ${index}`)])),
		);
		const warnings: string[] = [];
		harness.session.extensionRunner.setUIContext(
			createTestUiContext({
				notify: (message, type) => {
					if (type === "warning") warnings.push(message);
				},
			}),
			"tui",
		);
		await harness.session.prompt("watch the build");

		for (let event = 1; event <= TOOL_FREE_BREAKER + NOTICES_WHILE_PAUSED; event++) {
			await harness.session.sendCustomMessage(
				{ customType: "bench-monitor", content: `[monitor] event ${event}`, display: false },
				{ triggerTurn: true },
			);
			await harness.session.waitForIdle();
		}

		const refusals = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === ENGINE_TURN_LIMIT_ENTRY_TYPE);
		expect(refusals.length).toBeGreaterThan(1);
		expect(warnings.filter((message) => message.startsWith("Paused:"))).toHaveLength(1);
	});
});
