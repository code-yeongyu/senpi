import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

function countMessageText(messages: readonly AgentMessage[], text: string): number {
	return messages.filter((message) => getMessageText(message) === text).length;
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: (() => void) | undefined;
	const promise = new Promise<void>((next) => {
		resolve = next;
	});
	if (!resolve) throw new Error("Deferred resolver was not initialized");
	return { promise, resolve };
}

describe("issue #1329: trigger-turn custom messages enter before_agent_start", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("injects the hook result into the actual wake request exactly once", async () => {
		const hookPrompts: string[] = [];
		const providerRequests: Array<{ messages: AgentMessage[]; systemPrompt: string | undefined }> = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (event) => {
						hookPrompts.push(event.prompt);
						return {
							message: {
								customType: "issue-1329-hook",
								content: `hook-marker:${event.prompt}`,
								display: false,
							},
							systemPrompt: `${event.systemPrompt}\nissue-1329-system:${event.prompt}`,
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			(context) => {
				providerRequests.push({ messages: context.messages, systemPrompt: context.systemPrompt });
				return fauxAssistantMessage("normal complete");
			},
			(context) => {
				providerRequests.push({ messages: context.messages, systemPrompt: context.systemPrompt });
				return fauxAssistantMessage("wake complete");
			},
		]);

		await harness.session.prompt("normal");
		await harness.session.sendCustomMessage(
			{ customType: "issue-1329-trigger", content: "wake", display: false },
			{ triggerTurn: true, deliverAs: "followUp" },
		);

		expect(harness.faux.state.callCount).toBe(2);
		expect(hookPrompts).toEqual(["normal", "wake"]);
		const wakeRequest = providerRequests[1];
		expect(wakeRequest).toBeDefined();
		expect(countMessageText(wakeRequest?.messages ?? [], "wake")).toBe(1);
		expect(countMessageText(wakeRequest?.messages ?? [], "hook-marker:wake")).toBe(1);
		expect(wakeRequest?.systemPrompt).toContain("issue-1329-system:wake");
	});

	it("does not start a ghost turn when the user aborts a held trigger hook", async () => {
		const hookEntered = createDeferred();
		const releaseHook = createDeferred();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event) => {
						if (event.prompt !== "wake") return undefined;
						hookEntered.resolve();
						await releaseHook.promise;
						return {
							message: { customType: "issue-1329-hook", content: "hook-marker:wake", display: false },
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must not reach provider")]);

		const trigger = harness.session.sendCustomMessage(
			{ customType: "issue-1329-trigger", content: "wake", display: false },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		await hookEntered.promise;
		await harness.session.abort();
		releaseHook.resolve();
		await trigger;
		await harness.session.waitForSettledSessionWork();

		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);
		expect(
			harness.session.messages.some((message) => message.role === "custom" && getMessageText(message) === "wake"),
		).toBe(false);
	});

	it("queues the trigger message when its hook addition fails final admission", async () => {
		const hookPrompts: string[] = [];
		const oversizedHookMessage = "hook-added context ".repeat(2_000);
		const harness = await createHarness({
			models: [{ id: "issue-1329-final-admission", contextWindow: 5_000, maxTokens: 1_000 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1_000 } },
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (event) => {
						hookPrompts.push(event.prompt);
						return event.prompt === "wake"
							? {
									message: {
										customType: "issue-1329-oversized-hook",
										content: oversizedHookMessage,
										display: false,
									},
								}
							: undefined;
					});
					pi.on("session_before_compact", () => ({
						cancel: true,
						rejectionCause: "cancelled-by-extension",
						reason: "issue-1329 final-admission retention",
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("normal complete"), fauxAssistantMessage("must not reach provider")]);

		await harness.session.prompt("normal");
		await expect(
			harness.session.sendCustomMessage(
				{ customType: "issue-1329-trigger", content: "wake", display: false },
				{ triggerTurn: true, deliverAs: "followUp" },
			),
		).rejects.toThrow("Context remains above the compaction threshold because compaction did not complete");

		expect(hookPrompts).toEqual(["normal", "wake"]);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);
	});
});
