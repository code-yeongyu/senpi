import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../../src/index.ts";
import { createHarness, getAssistantTexts, getMessageText, getUserTexts, type Harness } from "../harness.ts";

/**
 * Regression: while a queued continuation (e.g. the goal extension's hidden
 * "goal-continuation" follow-up) holds the session-work barrier for an entire
 * agent run, `session.prompt(text, { streamingBehavior: "steer" })` used to
 * block inside `prompt()` until the whole run settled instead of queueing the
 * steering message. Typed input during an active goal chain was invisible (not
 * queued, not displayed) until the chain finished or the user pressed Esc.
 */

/** Mimics the goal extension: queue one hidden continuation after agent_end. */
function continuationExtension(pi: ExtensionAPI): void {
	let queued = false;
	pi.on("agent_end", async () => {
		if (queued) return;
		queued = true;
		// Yield like the goal store's file I/O so the run settles before the
		// follow-up is queued, forcing the scheduled-continuation launch path.
		await new Promise((resolve) => setTimeout(resolve, 0));
		pi.sendMessage(
			{ customType: "test-continuation", content: "continue the goal", display: false },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	});
}

describe("streaming prompt during queued continuation", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("queues a steer immediately instead of blocking until the continuation run settles", async () => {
		let releaseToolExecution: (() => void) | undefined;
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

		const harness = await createHarness({
			tools: [waitTool],
			extensionFactories: [continuationExtension],
		});
		harnesses.push(harness);

		harness.setResponses([
			// Turn 1: clean stop so the continuation extension re-engages the agent.
			fauxAssistantMessage("turn one done"),
			// Continuation turn: block on the wait tool while the user types.
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				const sawSteer = context.messages.some(
					(message) => message.role === "user" && getMessageText(message) === "typed during goal chain",
				);
				return fauxAssistantMessage(sawSteer ? "saw steer" : "missing steer");
			},
		]);

		const waitForToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start" && event.toolName === "wait") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.prompt("start");
		await waitForToolStart;

		// Before the fix this call deadlocked (test timeout): the scheduled
		// continuation held the session-work barrier for the whole run and
		// prompt() awaited it before queueing.
		await harness.session.prompt("typed during goal chain", { streamingBehavior: "steer" });
		expect(harness.session.pendingMessageCount).toBe(1);

		releaseToolExecution?.();
		await promptPromise;
		await harness.session.waitForIdle();

		expect(getUserTexts(harness)).toEqual(["start", "typed during goal chain"]);
		expect(getAssistantTexts(harness)).toContain("saw steer");
	});
});
