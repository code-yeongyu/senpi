/**
 * senpi#3588 follow-up: a multi-block custom message that triggers a turn reaches `before_agent_start`
 * with its text blocks joined by a newline, the same rule every user message follows (`userTextContent`),
 * instead of fused into one run of text.
 */

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { BeforeAgentStartEvent } from "../../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

describe("senpi#3588 trigger-turn prompt text", () => {
	it("joins a multi-block custom message's text blocks with a newline in before_agent_start", async () => {
		const seen: Pick<BeforeAgentStartEvent, "prompt" | "trigger">[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (event) => {
						seen.push({ prompt: event.prompt, trigger: event.trigger });
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.sendCustomMessage(
			{
				customType: "multi-block-trigger",
				content: [
					{ type: "text", text: "first block" },
					{ type: "text", text: "second block" },
				],
				display: false,
			},
			{ triggerTurn: true },
		);
		await harness.session.waitForSettledSessionWork();

		expect(seen).toEqual([{ prompt: "first block\nsecond block", trigger: "extension" }]);
	});
});
