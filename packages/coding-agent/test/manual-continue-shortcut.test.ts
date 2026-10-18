/**
 * Bare "." manual-continue shortcut coverage.
 *
 * A "." submitted alone on a session that already has messages must never
 * become a visible user turn: it resolves as handled (clearing the interactive
 * optimistic echo), is delivered as a hidden "manual-continue" custom message,
 * and drives a turn (new turn when idle, steer/follow-up continuation while
 * streaming). A "." on an empty session stays an ordinary user message.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { PromptDisposition } from "../src/core/agent-session.ts";
import { MANUAL_CONTINUE_CUSTOM_TYPE, MANUAL_CONTINUE_DIRECTIVE } from "../src/core/manual-continue.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import { createHarness, getAssistantTexts, getMessageText, getUserTexts, type Harness } from "./suite/harness.ts";

type EchoRecorderOptions = {
	promptDisposition: (disposition: PromptDisposition) => void;
	preflightResult: (success: boolean) => void;
};

/** Captures the disposition/preflight callbacks interactive mode uses to clear optimistic echoes. */
function recordEchoResolution(): {
	options: EchoRecorderOptions;
	dispositions: PromptDisposition[];
	preflights: boolean[];
} {
	const dispositions: PromptDisposition[] = [];
	const preflights: boolean[] = [];
	return {
		dispositions,
		preflights,
		options: {
			promptDisposition: (disposition) => dispositions.push(disposition),
			preflightResult: (success) => preflights.push(success),
		},
	};
}

function getManualContinueMessages(harness: Harness): CustomMessage[] {
	return harness.session.messages.filter(
		(message): message is CustomMessage =>
			message.role === "custom" && message.customType === MANUAL_CONTINUE_CUSTOM_TYPE,
	);
}

const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length > 0) {
		harnesses.pop()?.cleanup();
	}
});

describe("manual-continue shortcut", () => {
	it("turns a bare '.' on a non-empty session into a hidden manual-continue turn", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("continued")]);

		await harness.session.prompt("hello");

		const echo = recordEchoResolution();
		await harness.session.prompt(".", echo.options);

		expect(getUserTexts(harness)).toEqual(["hello"]);
		const manualContinues = getManualContinueMessages(harness);
		expect(manualContinues).toHaveLength(1);
		expect(manualContinues[0]?.display).toBe(false);
		expect(getMessageText(manualContinues[0])).toBe(MANUAL_CONTINUE_DIRECTIVE);
		expect(getAssistantTexts(harness)).toEqual(["first reply", "continued"]);
		expect(echo.dispositions).toEqual(["handled"]);
		expect(echo.preflights).toEqual([true]);
	});

	it("delivers a bare '.' during an active turn as a steer continuation, not a new user turn", async () => {
		let releaseToolExecution: () => void = () => {};
		const toolRelease = new Promise<void>((resolve) => {
			releaseToolExecution = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await toolRelease;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [waitTool] });
		harnesses.push(harness);

		const waitForToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start" && event.toolName === "wait") {
					unsubscribe();
					resolve();
				}
			});
		});

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("continued after steer"),
		]);

		const promptPromise = harness.session.prompt("start");
		await waitForToolStart;
		expect(harness.session.isStreaming).toBe(true);

		const echo = recordEchoResolution();
		await harness.session.prompt(".", { streamingBehavior: "steer", ...echo.options });

		expect(echo.dispositions).toEqual(["handled"]);
		expect(echo.preflights).toEqual([true]);

		releaseToolExecution();
		await promptPromise;

		expect(getUserTexts(harness)).toEqual(["start"]);
		const manualContinues = getManualContinueMessages(harness);
		expect(manualContinues).toHaveLength(1);
		expect(manualContinues[0]?.display).toBe(false);
		expect(getAssistantTexts(harness)).toContain("continued after steer");
	});

	it("treats a bare '.' on an empty session as an ordinary user message", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ordinary reply")]);

		const echo = recordEchoResolution();
		await harness.session.prompt(".", echo.options);

		expect(getUserTexts(harness)).toEqual(["."]);
		expect(getManualContinueMessages(harness)).toHaveLength(0);
		expect(getAssistantTexts(harness)).toEqual(["ordinary reply"]);
		expect(echo.dispositions).toEqual(["started"]);
		expect(echo.preflights).toEqual([true]);
	});

	it("treats a bare '.' with attached images as an ordinary user message", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("image reply")]);

		await harness.session.prompt("hello");

		const echo = recordEchoResolution();
		await harness.session.prompt(".", {
			images: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
			...echo.options,
		});

		expect(getUserTexts(harness)).toEqual(["hello", "."]);
		expect(getManualContinueMessages(harness)).toHaveLength(0);
		expect(getAssistantTexts(harness)).toEqual(["first reply", "image reply"]);
	});
});
