import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, getMessageText, getUserTexts, type Harness, type HarnessOptions } from "../harness.ts";

function createEchoTool(toolRuns: string[]): AgentTool {
	return {
		name: "echo",
		label: "Echo",
		description: "Echo text back",
		parameters: Type.Object({ text: Type.String() }),
		execute: async (_toolCallId, params) => {
			const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
			toolRuns.push(text);
			return { content: [{ type: "text", text: `echo:${text}` }], details: { text } };
		},
	};
}

async function settleWithin(promise: Promise<void>, timeoutMs: number): Promise<"settled" | "timed-out"> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise.then(() => "settled" as const),
			new Promise<"timed-out">((resolve) => {
				timeout = setTimeout(() => resolve("timed-out"), timeoutMs);
			}),
		]);
	} finally {
		if (timeout !== undefined) {
			clearTimeout(timeout);
		}
	}
}

async function createOverflowHarness(
	toolRuns: string[],
	extensionFactories: NonNullable<HarnessOptions["extensionFactories"]> = [],
): Promise<Harness> {
	return createHarness({
		models: [{ id: "faux-1", contextWindow: 128_000, maxTokens: 16 }],
		settings: {
			compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 1 },
			retry: { enabled: false },
		},
		tools: [createEchoTool(toolRuns)],
		extensionFactories: [
			(pi) => {
				pi.on("session_before_compact", async (event) => ({
					compaction: {
						summary: "overflow recovery summary",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						details: {},
					},
				}));
			},
			...extensionFactories,
		],
	});
}

function createOverflowResponse(harness: Harness, options: { timestamp?: number } = {}) {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage("", {
			stopReason: "error" as const,
			errorMessage:
				"Error Code context_too_large: Your input exceeds the context window of this model. Please adjust your input and try again.",
			timestamp: options.timestamp,
		}),
		api: model.api,
		provider: model.provider,
		model: model.id,
	};
}

function getPersistedAssistantTexts(harness: Harness): string[] {
	return harness.sessionManager.getEntries().flatMap((entry) => {
		if (entry.type !== "message" || entry.message.role !== "assistant") {
			return [];
		}
		return [getMessageText(entry.message)];
	});
}

function getPersistedAssistantErrorMessages(harness: Harness): string[] {
	return harness.sessionManager.getEntries().flatMap((entry) => {
		if (entry.type !== "message" || entry.message.role !== "assistant" || !entry.message.errorMessage) {
			return [];
		}
		return [entry.message.errorMessage];
	});
}

describe("post-compaction tool continuation regression", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("resumes a post-compaction overflow retry through a tool without queued input", async () => {
		const toolRuns: string[] = [];
		const harness = await createOverflowHarness(toolRuns);
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("seed response"),
			createOverflowResponse(harness),
			fauxAssistantMessage([fauxToolCall("echo", { text: "after-compaction" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("recovered after tool"),
		]);

		await harness.session.prompt("seed prompt");
		const settledBeforeRecovery = harness.eventsOfType("agent_settled").length;
		const prompt = harness.session.prompt("initial overflow prompt");

		expect({
			promptResult: await settleWithin(prompt, 500),
			toolExecutions: toolRuns.length,
		}).toEqual({
			promptResult: "settled",
			toolExecutions: 1,
		});
		expect(harness.faux.state.callCount).toBe(4);
		expect(toolRuns).toEqual(["after-compaction"]);
		expect(getUserTexts(harness)).toEqual(["initial overflow prompt"]);
		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(compactionEntries).toHaveLength(1);
		expect(compactionEntries.map((entry) => entry.summary)).toEqual(["overflow recovery summary"]);
		expect(
			harness.eventsOfType("compaction_end").map((event) => ({
				reason: event.reason,
				aborted: event.aborted,
				willRetry: event.willRetry,
			})),
		).toEqual([{ reason: "overflow", aborted: false, willRetry: true }]);
		expect(getPersistedAssistantTexts(harness)).toContain("recovered after tool");
		expect(harness.eventsOfType("agent_settled")).toHaveLength(settledBeforeRecovery + 1);
	});

	it("runs a queued follow-up tool after the current turn settles", async () => {
		const toolRuns: string[] = [];
		let queuedContinuation = false;
		const harness = await createHarness({
			tools: [createEchoTool(toolRuns)],
			extensionFactories: [
				(pi) => {
					pi.on("agent_end", () => {
						if (queuedContinuation) return;
						queuedContinuation = true;
						pi.sendUserMessage("automatic continuation", { deliverAs: "followUp" });
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("initial answer"),
			fauxAssistantMessage([fauxToolCall("echo", { text: "automatic-follow-up" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("automatic continuation complete"),
		]);

		const prompt = harness.session.prompt("initial prompt");

		expect(await settleWithin(prompt, 500)).toBe("settled");
		expect(toolRuns).toEqual(["automatic-follow-up"]);
		expect(harness.faux.state.callCount).toBe(3);
		expect(getUserTexts(harness)).toEqual(["initial prompt", "automatic continuation"]);
		expect(getPersistedAssistantTexts(harness)).toContain("automatic continuation complete");
	});

	it("settles and releases session work when a deferred queued continuation cannot start", async () => {
		let queuedContinuation = false;
		let activeHarness: Harness | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_end", async () => {
						if (queuedContinuation) return;
						queuedContinuation = true;
						const currentHarness = activeHarness;
						if (!currentHarness) throw new Error("Harness was not initialized");
						await currentHarness.session.agent.waitForIdle();
						currentHarness.session.agent.followUp({
							role: "user",
							content: [{ type: "text", text: "rejected continuation" }],
							timestamp: Date.now(),
						});
					});
				},
			],
		});
		activeHarness = harness;
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("initial answer"), fauxAssistantMessage("next prompt answer")]);
		const continueSpy = vi
			.spyOn(harness.session.agent, "continue")
			.mockRejectedValueOnce("deferred continuation failed");

		const settledBeforePrompt = harness.eventsOfType("agent_settled").length;
		const firstPrompt = harness.session.prompt("initial prompt");

		expect(await settleWithin(firstPrompt, 500)).toBe("settled");
		expect(continueSpy).toHaveBeenCalledTimes(1);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(settledBeforePrompt + 1);
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);
		harness.session.clearQueue();

		const nextPrompt = harness.session.prompt("next prompt");

		expect(await settleWithin(nextPrompt, 500)).toBe("settled");
		expect(harness.faux.state.callCount).toBe(2);
		expect(getUserTexts(harness)).toEqual(["initial prompt", "next prompt"]);
		expect(getPersistedAssistantTexts(harness)).toContain("next prompt answer");
		expect(harness.eventsOfType("agent_settled")).toHaveLength(settledBeforePrompt + 2);
	});

	it("caps a repeated overflow after one compact-and-retry attempt", async () => {
		const toolRuns: string[] = [];
		const harness = await createOverflowHarness(toolRuns);
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("seed response"),
			createOverflowResponse(harness),
			() => createOverflowResponse(harness, { timestamp: Date.now() + 60_000 }),
		]);

		await harness.session.prompt("seed prompt");
		const settledBeforeRecovery = harness.eventsOfType("agent_settled").length;
		const prompt = harness.session.prompt("overflow twice");

		expect(await settleWithin(prompt, 500)).toBe("settled");
		expect(toolRuns).toEqual([]);
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(
			harness.eventsOfType("compaction_end").map((event) => ({
				accepted: event.accepted,
				errorMessage: event.errorMessage,
				willRetry: event.willRetry,
			})),
		).toEqual([
			{ accepted: true, errorMessage: undefined, willRetry: true },
			{
				accepted: undefined,
				errorMessage: expect.stringMatching(
					/^Context overflow recovery failed after one compact-and-retry attempt/,
				),
				willRetry: false,
			},
		]);
		expect(getPersistedAssistantErrorMessages(harness)).toHaveLength(2);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(settledBeforeRecovery + 1);
	});
});
