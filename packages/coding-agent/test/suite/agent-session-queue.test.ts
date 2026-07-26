import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/index.ts";
import {
	createHarness,
	getAssistantTexts,
	getMessageText,
	getUserTexts,
	type Harness,
	type HarnessOptions,
} from "./harness.ts";

async function createWaitingHarness(options: Pick<HarnessOptions, "extensionFactories" | "tools"> = {}): Promise<{
	harness: Harness;
	releaseToolExecution: () => void;
	promptPromise: Promise<void>;
	waitForToolStart: Promise<void>;
}> {
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
			return {
				content: [{ type: "text", text: "released" }],
				details: {},
			};
		},
	};
	const harness = await createHarness({
		tools: [waitTool, ...(options.tools ?? [])],
		extensionFactories: options.extensionFactories,
	});

	const waitForToolStart = new Promise<void>((resolve) => {
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "tool_execution_start" && event.toolName === "wait") {
				unsubscribe();
				resolve();
			}
		});
	});

	return {
		harness,
		releaseToolExecution: () => releaseToolExecution?.(),
		promptPromise: harness.session.prompt("start"),
		waitForToolStart,
	};
}

function getWaitForSettledSessionWork(harness: Harness) {
	const wait = Reflect.get(harness.session, "_waitForSettledSessionWork");
	if (typeof wait !== "function") throw new Error("Expected AgentSession._waitForSettledSessionWork");
	return (): Promise<void> => Promise.resolve(wait.call(harness.session));
}

function getSessionWorkBarrier(harness: Harness): { readonly hasActiveWork: boolean } {
	const barrier = Reflect.get(harness.session, "_sessionWorkBarrier");
	if (!barrier || typeof barrier !== "object" || !("hasActiveWork" in barrier)) {
		throw new Error("Expected AgentSession._sessionWorkBarrier");
	}
	return barrier as { readonly hasActiveWork: boolean };
}

describe("AgentSession queue characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("dispatches extension commands immediately when prompted while idle", async () => {
		const commandRuns: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("testcmd", {
						description: "Test command",
						handler: async (args) => {
							commandRuns.push(args);
						},
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("/testcmd hello world");

		expect(commandRuns).toEqual(["hello world"]);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.messages).toEqual([]);
	});

	it("delivers extension-origin steering messages before the next LLM call", async () => {
		let extensionApi: ExtensionAPI | undefined;
		const waiting = await createWaitingHarness({
			extensionFactories: [
				(pi) => {
					extensionApi = pi;
				},
			],
		});
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				const sawSteer = context.messages.some(
					(message) => message.role === "user" && getMessageText(message) === "steer now",
				);
				return fauxAssistantMessage(sawSteer ? "saw steer" : "missing steer");
			},
		]);

		await waitForToolStart;
		await new Promise((resolve) => setTimeout(resolve, 0));

		extensionApi?.sendUserMessage("steer now", { deliverAs: "steer" });
		releaseToolExecution();
		await promptPromise;

		expect(getUserTexts(harness)).toEqual(["start", "steer now"]);
		expect(getAssistantTexts(harness)).toContain("saw steer");
	});

	it("waits for manual compaction before admitting a background extension prompt", async () => {
		const marker = "background extension prompt";
		const summary = "manual compaction summary before extension admission";
		let extensionApi: ExtensionAPI | undefined;
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					extensionApi = pi;
					pi.on("session_before_compact", (event) => {
						queueMicrotask(() => {
							pi.sendUserMessage(marker, { deliverAs: "followUp" });
						});
						return {
							compaction: {
								summary,
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("seed response")]);
		await harness.session.prompt("seed manual compaction context");

		const waitForSettledSessionWork = getWaitForSettledSessionWork(harness);
		const barrier = getSessionWorkBarrier(harness);
		const barrierStatesAtExtensionAdmission: boolean[] = [];
		Reflect.set(harness.session, "_waitForSettledSessionWork", async () => {
			barrierStatesAtExtensionAdmission.push(barrier.hasActiveWork);
			await waitForSettledSessionWork();
		});
		let providerCallsAtAcceptedCompaction: number | undefined;
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.accepted) {
				providerCallsAtAcceptedCompaction = harness.faux.state.callCount;
			}
		});
		let extensionRequest = "";
		harness.setResponses([
			(context) => {
				extensionRequest = JSON.stringify(context.messages);
				return fauxAssistantMessage("extension prompt handled");
			},
		]);

		await harness.session.compact();
		await harness.session.waitForSettledSessionWork();

		expect(extensionApi).toBeDefined();
		expect(barrierStatesAtExtensionAdmission[0]).toBe(true);
		expect(providerCallsAtAcceptedCompaction).toBe(1);
		expect(extensionRequest).toContain(summary);
		expect(getUserTexts(harness).filter((text) => text === marker)).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it.each([
		"rejected",
		"aborted",
	] as const)("keeps a background extension follow-up fail-closed after a %s manual compaction", async (outcome) => {
		const marker = `retain extension follow-up after ${outcome} compaction`;
		let compactionAttempt = 0;
		let resolveFirstCompactionStart: (() => void) | undefined;
		const firstCompactionStarted = new Promise<void>((resolve) => {
			resolveFirstCompactionStart = resolve;
		});
		const harness = await createHarness({
			models: [{ id: `extension-${outcome}-compaction`, contextWindow: 5_000, maxTokens: 1_000 }],
			settings: { compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 1_000 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						compactionAttempt += 1;
						if (compactionAttempt === 1) {
							queueMicrotask(() => {
								pi.sendUserMessage(marker, { deliverAs: "followUp" });
							});
							resolveFirstCompactionStart?.();
						}
						if (outcome === "rejected" || compactionAttempt > 1) {
							return { cancel: true, rejectionCause: "cancelled-by-extension" };
						}
						return await new Promise<{ cancel: true }>((resolve) => {
							event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
						});
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("seed response")]);
		await harness.session.prompt("pre-compaction context ".repeat(1_600));
		harness.settingsManager.applyOverrides({
			compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1_000 },
		});

		const waitForSettledSessionWork = getWaitForSettledSessionWork(harness);
		const barrier = getSessionWorkBarrier(harness);
		const barrierStatesAtExtensionAdmission: boolean[] = [];
		Reflect.set(harness.session, "_waitForSettledSessionWork", async () => {
			barrierStatesAtExtensionAdmission.push(barrier.hasActiveWork);
			await waitForSettledSessionWork();
		});
		const compact = harness.session.compact();
		await firstCompactionStarted;
		if (outcome === "aborted") harness.session.abortCompaction();
		await compact.catch(() => undefined);
		await harness.session.waitForSettledSessionWork();

		expect(barrierStatesAtExtensionAdmission[0]).toBe(true);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.getFollowUpMessages()).toEqual([marker]);
	});

	it.each([
		"accepted",
		"rejected",
		"aborted",
	] as const)("keeps pi.sendMessage({ triggerTurn: true }) behind the %s manual compaction boundary", async (outcome) => {
		const marker = `custom trigger-turn during ${outcome} manual compaction`;
		let beforeCompactCalls = 0;
		let resolveBeforeCompact: (() => void) | undefined;
		const beforeCompact = new Promise<void>((resolve) => {
			resolveBeforeCompact = resolve;
		});
		const providerContexts: AgentMessage[][] = [];
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						beforeCompactCalls++;
						pi.sendMessage(
							{
								customType: "compaction-trigger-turn",
								content: marker,
								display: false,
							},
							{ triggerTurn: true },
						);
						resolveBeforeCompact?.();

						if (outcome === "accepted") {
							return {
								compaction: {
									summary: `accepted summary before ${marker}`,
									firstKeptEntryId: event.preparation.firstKeptEntryId,
									tokensBefore: event.preparation.tokensBefore,
								},
							};
						}
						if (outcome === "rejected") {
							return { cancel: true, rejectionCause: "cancelled-by-extension" as const };
						}
						return await new Promise<{ cancel: true }>((resolve) => {
							event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
						});
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("seed response")]);
		await harness.session.prompt("seed manual compaction context");
		harness.setResponses([
			(context) => {
				providerContexts.push(context.messages);
				return fauxAssistantMessage("custom trigger-turn handled");
			},
		]);

		const compact = harness.session.compact();
		await beforeCompact;
		if (outcome === "aborted") harness.session.abortCompaction();
		if (outcome === "accepted") {
			await compact;
		} else {
			await compact.catch(() => undefined);
		}
		await harness.session.waitForSettledSessionWork();
		await harness.session.agent.waitForIdle();

		expect(beforeCompactCalls).toBe(1);
		if (outcome === "accepted") {
			expect(harness.faux.state.callCount).toBe(2);
			expect(providerContexts).toHaveLength(1);
			const providerContext = providerContexts[0] ?? [];
			const summaryIndex = providerContext.findIndex(
				(message) => message.role === "user" && getMessageText(message).includes("accepted summary"),
			);
			const customIndex = providerContext.findIndex(
				(message) => message.role === "user" && getMessageText(message) === marker,
			);
			expect(summaryIndex).toBeGreaterThanOrEqual(0);
			expect(customIndex).toBeGreaterThan(summaryIndex);
			expect(
				harness.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "custom_message" && entry.content === marker),
			).toHaveLength(1);
		} else {
			expect(harness.faux.state.callCount).toBe(1);
			expect(providerContexts).toEqual([]);
			expect(harness.session.agent.hasQueuedMessages()).toBe(true);
		}
	});

	it("delivers follow-up messages only after the current run finishes", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		const assistantSeenBeforeFollowUp: string[] = [];

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				assistantSeenBeforeFollowUp.push(
					...context.messages
						.filter((message) => message.role === "assistant")
						.map((message) =>
							message.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n"),
						),
				);
				return fauxAssistantMessage("follow-up response");
			},
		]);

		await waitForToolStart;
		await harness.session.followUp("after current run");
		releaseToolExecution();
		await promptPromise;

		expect(getUserTexts(harness)).toEqual(["start", "after current run"]);
		expect(assistantSeenBeforeFollowUp).toContain("");
		expect(getAssistantTexts(harness)).toContain("follow-up response");
	});

	it("delivers multiple steering messages in order in one-at-a-time mode", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("handled steer 1"),
			fauxAssistantMessage("handled steer 2"),
		]);

		await waitForToolStart;
		await harness.session.steer("steer 1");
		await harness.session.steer("steer 2");
		releaseToolExecution();
		await promptPromise;

		expect(getUserTexts(harness)).toEqual(["start", "steer 1", "steer 2"]);
		expect(getAssistantTexts(harness)).toEqual(["", "handled steer 1", "handled steer 2"]);
	});

	it("delivers multiple follow-up messages in order in one-at-a-time mode", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("original turn complete"),
			fauxAssistantMessage("handled follow-up 1"),
			fauxAssistantMessage("handled follow-up 2"),
		]);

		await waitForToolStart;
		await harness.session.followUp("follow-up 1");
		await harness.session.followUp("follow-up 2");
		releaseToolExecution();
		await promptPromise;

		expect(getUserTexts(harness)).toEqual(["start", "follow-up 1", "follow-up 2"]);
		expect(getAssistantTexts(harness)).toEqual([
			"",
			"original turn complete",
			"handled follow-up 1",
			"handled follow-up 2",
		]);
	});

	it("delivers all steering messages in one batch in all mode", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		harness.session.setSteeringMode("all");
		let batchedUserMessages: string[] = [];

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				batchedUserMessages = context.messages
					.filter((message) => message.role === "user")
					.map((message) => getMessageText(message));
				return fauxAssistantMessage("batched steer response");
			},
		]);

		await waitForToolStart;
		await harness.session.steer("steer 1");
		await harness.session.steer("steer 2");
		releaseToolExecution();
		await promptPromise;

		expect(batchedUserMessages).toEqual(["start", "steer 1", "steer 2"]);
		expect(getAssistantTexts(harness)).toEqual(["", "batched steer response"]);
	});

	it("delivers all follow-up messages in one batch in all mode", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		harness.session.setFollowUpMode("all");
		let batchedUserMessages: string[] = [];

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("original turn complete"),
			(context) => {
				batchedUserMessages = context.messages
					.filter((message) => message.role === "user")
					.map((message) => getMessageText(message));
				return fauxAssistantMessage("batched follow-up response");
			},
		]);

		await waitForToolStart;
		await harness.session.followUp("follow-up 1");
		await harness.session.followUp("follow-up 2");
		releaseToolExecution();
		await promptPromise;

		expect(batchedUserMessages).toEqual(["start", "follow-up 1", "follow-up 2"]);
		expect(getAssistantTexts(harness)).toEqual(["", "original turn complete", "batched follow-up response"]);
	});

	it("queues custom messages with deliverAs steer while streaming", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		let sawCustomMessage = false;

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				sawCustomMessage = context.messages.some(
					(message) =>
						message.role === "user" &&
						typeof message.content !== "string" &&
						message.content.some((part) => part.type === "text" && part.text === "steer custom"),
				);
				return fauxAssistantMessage("done");
			},
		]);

		await waitForToolStart;
		await harness.session.sendCustomMessage(
			{ customType: "queue-test", content: "steer custom", display: true, details: { value: 1 } },
			{ deliverAs: "steer" },
		);
		releaseToolExecution();
		await promptPromise;

		expect(sawCustomMessage).toBe(true);
		expect(
			harness.session.messages.some((message) => message.role === "custom" && message.customType === "queue-test"),
		).toBe(true);
	});

	it("queues custom messages with deliverAs followUp while streaming", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		let sawCustomMessage = false;

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("original turn complete"),
			(context) => {
				sawCustomMessage = context.messages.some(
					(message) =>
						message.role === "user" &&
						typeof message.content !== "string" &&
						message.content.some((part) => part.type === "text" && part.text === "follow-up custom"),
				);
				return fauxAssistantMessage("done");
			},
		]);

		await waitForToolStart;
		await harness.session.sendCustomMessage(
			{ customType: "queue-test", content: "follow-up custom", display: true, details: { value: 1 } },
			{ deliverAs: "followUp" },
		);
		releaseToolExecution();
		await promptPromise;

		expect(sawCustomMessage).toBe(true);
		expect(
			harness.session.messages.some((message) => message.role === "custom" && message.customType === "queue-test"),
		).toBe(true);
	});

	it("injects nextTurn custom messages into the next prompt", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let sawCustomMessage = false;

		await harness.session.sendCustomMessage(
			{ customType: "next-turn", content: "carry this", display: true, details: {} },
			{ deliverAs: "nextTurn" },
		);

		harness.setResponses([
			(context) => {
				sawCustomMessage = context.messages.some(
					(message) =>
						message.role === "user" &&
						typeof message.content !== "string" &&
						message.content.some((part) => part.type === "text" && part.text === "carry this"),
				);
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("normal prompt");

		expect(sawCustomMessage).toBe(true);
		expect(harness.session.messages.map((message) => message.role)).toEqual(["user", "custom", "assistant"]);
	});

	it("updates pendingMessageCount and removes queued text before message_start is emitted", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		const countsAtQueuedMessageStart: number[] = [];

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		harness.session.subscribe((event) => {
			if (
				event.type === "message_start" &&
				event.message.role === "user" &&
				getMessageText(event.message) === "queued"
			) {
				countsAtQueuedMessageStart.push(harness.session.pendingMessageCount);
			}
		});

		await waitForToolStart;
		await harness.session.steer("queued");
		expect(harness.session.pendingMessageCount).toBe(1);
		releaseToolExecution();
		await promptPromise;

		expect(countsAtQueuedMessageStart).toEqual([0]);
		expect(harness.session.pendingMessageCount).toBe(0);
	});

	it("starts a fresh turn for steer input submitted while a user abort is settling", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		let freshTurnUserMessages: string[] = [];

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				freshTurnUserMessages = context.messages
					.filter((message) => message.role === "user")
					.map((message) => getMessageText(message));
				return fauxAssistantMessage("fresh steer response");
			},
		]);

		await waitForToolStart;
		const abortPromise = harness.session.abort();
		const secondAbortPromise = harness.session.abort();
		const freshPromptPromise = harness.session.prompt("fresh after abort", { streamingBehavior: "steer" });

		expect(harness.session.isStreaming).toBe(true);
		releaseToolExecution();
		await Promise.all([promptPromise, abortPromise, secondAbortPromise, freshPromptPromise]);

		expect(freshTurnUserMessages).toEqual(["start", "fresh after abort"]);
		expect(getUserTexts(harness)).toEqual(["start", "fresh after abort"]);
		expect(getAssistantTexts(harness)).toEqual(["", "fresh steer response"]);
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("starts a fresh turn for follow-up input submitted while a user abort is settling", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		let freshTurnUserMessages: string[] = [];

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				freshTurnUserMessages = context.messages
					.filter((message) => message.role === "user")
					.map((message) => getMessageText(message));
				return fauxAssistantMessage("fresh follow-up response");
			},
		]);

		await waitForToolStart;
		const abortPromise = harness.session.abort();
		const freshPromptPromise = harness.session.prompt("fresh follow-up after abort", {
			streamingBehavior: "followUp",
		});

		expect(harness.session.isStreaming).toBe(true);
		releaseToolExecution();
		await Promise.all([promptPromise, abortPromise, freshPromptPromise]);

		expect(freshTurnUserMessages).toEqual(["start", "fresh follow-up after abort"]);
		expect(getUserTexts(harness)).toEqual(["start", "fresh follow-up after abort"]);
		expect(getAssistantTexts(harness)).toEqual(["", "fresh follow-up response"]);
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("throws when queueing an extension command with steer", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("testcmd", {
						description: "Test command",
						handler: async () => {},
					});
				},
			],
		});
		harnesses.push(harness);

		await expect(harness.session.steer("/testcmd queued")).rejects.toThrow(
			'Extension command "/testcmd" cannot be queued. Use prompt() or execute the command when not streaming.',
		);
	});

	it("throws when queueing an extension command with followUp", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("testcmd", {
						description: "Test command",
						handler: async () => {},
					});
				},
			],
		});
		harnesses.push(harness);

		await expect(harness.session.followUp("/testcmd queued")).rejects.toThrow(
			'Extension command "/testcmd" cannot be queued. Use prompt() or execute the command when not streaming.',
		);
	});

	it("delivers follow-ups queued during agent_end", async () => {
		let sent = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.on("agent_end", async () => {
						if (sent) return;
						sent = true;
						pi.sendUserMessage("conflict report", { deliverAs: "followUp" });
					});
				},
			],
		});
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("reply"), fauxAssistantMessage("follow-up reply")]);

		await harness.session.prompt("hello");
		await harness.session.agent.waitForIdle();

		expect(getUserTexts(harness)).toEqual(["hello", "conflict report"]);
	});
});
