import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { AssistantMessageComponent } from "../../../src/modes/interactive/components/assistant-message.ts";
import { StreamingRevealController } from "../../../src/modes/interactive/streaming-reveal.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";

function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5.6-sol-fast",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 0,
	};
}

describe("pending assistant stop-reason rendering", () => {
	test("renders an empty pending assistant message without throwing", () => {
		// given
		initTheme("dark");
		const givenMessage = assistantMessage([], "pending");

		// when
		const whenRendered = new AssistantMessageComponent(givenMessage).render(80);

		// then
		expect(whenRendered).toEqual([]);
	});

	test("transitions from a pending start to visible streamed text", () => {
		// given
		initTheme("dark");
		const givenComponent = new AssistantMessageComponent();
		const givenController = new StreamingRevealController({
			getSmoothStreaming: () => false,
			getSmoothStreamingFps: () => 30,
			getHideThinkingBlock: () => false,
			requestRender: () => {},
		});

		// when
		givenController.begin(givenComponent, assistantMessage([], "pending"));
		givenController.setTarget(assistantMessage([{ type: "text", text: "stable answer" }], "stop"));

		// then
		expect(stripAnsi(givenComponent.render(80).join("\n"))).toContain("stable answer");
	});
});
