import { type AssistantMessage, createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.js";

<<<<<<< HEAD
type CheckCompaction = (
	assistantMessage: AssistantMessage,
	skipAbortedCheck?: boolean,
	requestReason?: "pre_prompt",
) => Promise<void>;
type RunAutoCompaction = (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void>;

function getCheckCompaction(session: Harness["session"]): CheckCompaction {
	const value = Reflect.get(session, "_checkCompaction");
	if (typeof value !== "function") {
		throw new Error("AgentSession._checkCompaction is not available for characterization tests");
	}
	return value;
}

function getRunAutoCompaction(session: Harness["session"]): RunAutoCompaction {
	const value = Reflect.get(session, "_runAutoCompaction");
	if (typeof value !== "function") {
		throw new Error("AgentSession._runAutoCompaction is not available for characterization tests");
	}
	return value;
}

async function checkCompaction(
	session: Harness["session"],
	assistantMessage: AssistantMessage,
	skipAbortedCheck?: boolean,
	requestReason?: "pre_prompt",
): Promise<void> {
	await getCheckCompaction(session).call(session, assistantMessage, skipAbortedCheck, requestReason);
}

async function runAutoCompaction(
	session: Harness["session"],
	reason: "overflow" | "threshold",
	willRetry: boolean,
): Promise<void> {
	await getRunAutoCompaction(session).call(session, reason, willRetry);
}

function stubRunAutoCompaction(session: Harness["session"]) {
	const stub = vi.fn(async (_reason: "overflow" | "threshold", _willRetry: boolean): Promise<void> => {});
	Reflect.set(session, "_runAutoCompaction", stub);
	return stub;
}
=======
type SessionWithCompactionInternals = {
	_checkCompaction: (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<boolean>;
	_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
};
>>>>>>> upstream/main

function createUsage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(
	harness: Harness,
	options: {
		text?: string;
		stopReason?: AssistantMessage["stopReason"];
		errorMessage?: string;
		totalTokens?: number;
		timestamp?: number;
	},
): AssistantMessage {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage(options.text ?? "", {
			stopReason: options.stopReason,
			errorMessage: options.errorMessage,
			timestamp: options.timestamp,
		}),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(options.totalTokens ?? 0),
	};
}

function useSummaryStreamFn(harness: Harness, summary: string): () => number {
	let callCount = 0;
	harness.session.agent.streamFn = (model) => {
		callCount++;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const message: AssistantMessage = {
				...fauxAssistantMessage(summary),
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: createUsage(10),
			};
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
	return () => callCount;
}

function seedCompactableSession(harness: Harness): void {
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to compact" }],
		timestamp: now - 1000,
	});
	harness.sessionManager.appendMessage(
		createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 100,
			timestamp: now - 500,
		}),
	);
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to keep" }],
		timestamp: now,
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("AgentSession compaction characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("manually compacts using an extension-provided summary", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: { source: "extension" },
						},
					}));
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const result = await harness.session.compact();
		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");

		expect(result.summary).toBe("summary from extension");
		expect(compactionEntries).toHaveLength(1);
		expect(harness.session.messages[0]?.role).toBe("compactionSummary");
	});

	it("throws when compacting without a model", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		Reflect.set(harness.session.agent.state, "model", undefined);

		await expect(harness.session.compact()).rejects.toThrow("No model selected");
	});

	it("throws when manually compacting a session that fits within keepRecentTokens", async () => {
		// given
		const harness = await createHarness();
		harnesses.push(harness);

		await harness.session.prompt("hi");
		await harness.session.prompt("who are you");

		// when / then
		await expect(harness.session.compact()).rejects.toThrow("Nothing to compact (session too small)");
		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(compactionEntries).toHaveLength(0);
	});

	it("throws when compacting without configured auth", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			withConfiguredAuth: false,
		});
		harnesses.push(harness);

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "first user" }],
			timestamp: Date.now() - 2000,
		});
		harness.sessionManager.appendMessage(createAssistant(harness, { text: "first assistant", totalTokens: 100 }));
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "second user" }],
			timestamp: Date.now(),
		});

		await expect(harness.session.compact()).rejects.toThrow(`No API key found for ${harness.getModel().provider}.`);
	});

	it("manually compacts with a custom streamFn when registry auth is absent", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			withConfiguredAuth: false,
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const getStreamCallCount = useSummaryStreamFn(harness, "summary from custom stream");

		const result = await harness.session.compact();

		expect(result.summary).toBe("summary from custom stream");
		expect(getStreamCallCount()).toBe(1);
	});

	it("auto-compacts with a custom streamFn when registry auth is absent", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			withConfiguredAuth: false,
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const getStreamCallCount = useSummaryStreamFn(harness, "auto summary from custom stream");

		await runAutoCompaction(harness.session, "threshold", false);

		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(compactionEntries).toHaveLength(1);
		expect(getStreamCallCount()).toBe(1);
	});

	it("cancels in-progress manual compaction when abortCompaction is called", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						return await new Promise<{ cancel: true }>((resolve) => {
							event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
						});
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const compactPromise = harness.session.compact();
		await new Promise((resolve) => setTimeout(resolve, 0));
		harness.session.abortCompaction();

		await expect(compactPromise).rejects.toThrow("Compaction cancelled");
	});

	it("resumes after threshold compaction when only agent-level queued messages exist", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "auto compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		harness.session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "queued custom" }],
			display: false,
			timestamp: Date.now(),
		});

<<<<<<< HEAD
		const continueSpy = vi.spyOn(harness.session.agent, "continue").mockResolvedValue();

		await runAutoCompaction(harness.session, "threshold", false);
		await vi.advanceTimersByTimeAsync(100);

		expect(continueSpy).toHaveBeenCalledTimes(1);
=======
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(sessionInternals._runAutoCompaction("threshold", false)).resolves.toBe(true);
>>>>>>> upstream/main
	});

	it("does not retry overflow recovery more than once", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const overflowMessage = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "prompt is too long",
			timestamp: Date.now(),
		});
<<<<<<< HEAD
		const runAutoCompactionSpy = stubRunAutoCompaction(harness.session);
=======
		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);
>>>>>>> upstream/main
		const compactionErrors: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.errorMessage) {
				compactionErrors.push(event.errorMessage);
			}
		});

		await checkCompaction(harness.session, overflowMessage);
		await checkCompaction(harness.session, { ...overflowMessage, timestamp: Date.now() + 1 });

		expect(runAutoCompactionSpy).toHaveBeenCalledTimes(1);
		expect(compactionErrors).toContain(
			"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
		);
	});

	it("blocks pre-prompt continuation after overflow recovery already failed", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const firstOverflow = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "prompt is too long",
			timestamp: Date.now(),
		});
		const secondOverflow = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "prompt is too long",
			timestamp: Date.now() + 1,
		});
		const userMessage = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "continue" }],
			timestamp: Date.now() - 1,
		};
		const runAutoCompactionSpy = stubRunAutoCompaction(harness.session);

		//#given - overflow recovery already used its compact-and-retry attempt
		await checkCompaction(harness.session, firstOverflow);
		harness.session.agent.state.messages = [userMessage, secondOverflow];

		//#when - a continuation tries to start another turn while the latest assistant is still overflowed
		const prompt = harness.session.prompt("continue goal");

		//#then - the prompt is blocked before another doomed provider request can be sent
		await expect(prompt).rejects.toThrow(
			"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
		);
		expect(runAutoCompactionSpy).toHaveBeenCalledTimes(1);
	});

	it("does not consume the overflow compact-and-retry attempt when compaction fails before retrying", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		const firstOverflow = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "prompt is too long",
			timestamp: Date.now(),
		});
		const secondOverflow = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "prompt is too long",
			timestamp: Date.now() + 1,
		});
		const userMessage = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "continue" }],
			timestamp: Date.now() - 1,
		};

		harness.session.agent.state.messages = [userMessage, firstOverflow];
		await checkCompaction(harness.session, firstOverflow);
		harness.session.agent.state.messages = [userMessage, secondOverflow];
		await checkCompaction(harness.session, secondOverflow);

		const overflowStarts = harness.eventsOfType("compaction_start").filter((event) => event.reason === "overflow");
		const terminalOverflowFailures = harness
			.eventsOfType("compaction_end")
			.filter((event) =>
				event.errorMessage?.startsWith("Context overflow recovery failed after one compact-and-retry attempt"),
			);
		expect(overflowStarts).toHaveLength(2);
		expect(terminalOverflowFailures).toHaveLength(0);
	});

	it("auto-retries overflow recovery when a provider alias differs but current context is still near the limit", async () => {
		const harness = await createHarness({
			api: "openai-codex-responses",
			provider: "openai-codex",
			models: [
				{
					id: "gpt-5.5",
					contextWindow: 272_000,
				},
			],
			settings: { compaction: { enabled: true, reserveTokens: 16_384 } },
		});
		harnesses.push(harness);
		const successfulAssistant = {
			...createAssistant(harness, {
				stopReason: "stop",
				totalTokens: 260_000,
				timestamp: Date.now() - 1_000,
			}),
			provider: "openai",
			model: "gpt-5.5",
		};
		const overflowMessage = {
			...createAssistant(harness, {
				stopReason: "error",
				errorMessage:
					"Your input exceeds the context window of this model. Please adjust your input and try again.",
				timestamp: Date.now(),
			}),
			provider: "openai",
			model: "gpt-5.5",
		};
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "initial work" }], timestamp: Date.now() - 2_000 },
			successfulAssistant,
			{ role: "user", content: [{ type: "text", text: "continue" }], timestamp: Date.now() - 500 },
			overflowMessage,
		];

		const runAutoCompactionSpy = stubRunAutoCompaction(harness.session);

		await checkCompaction(harness.session, overflowMessage);

		expect(runAutoCompactionSpy).toHaveBeenCalledWith("overflow", true);
	});

	it("ignores stale pre-compaction assistant usage on pre-prompt checks", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const staleTimestamp = Date.now() - 10_000;
		const staleAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 610_000,
			timestamp: staleTimestamp,
		});

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: staleTimestamp - 1000,
		});
		harness.sessionManager.appendMessage(staleAssistant);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction(
			"summary",
			firstKeptEntryId,
			staleAssistant.usage.totalTokens,
			undefined,
			false,
		);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "after compaction" }],
			timestamp: Date.now(),
		});

<<<<<<< HEAD
		const runAutoCompactionSpy = stubRunAutoCompaction(harness.session);
=======
		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);
>>>>>>> upstream/main

		await checkCompaction(harness.session, staleAssistant, false);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("triggers threshold compaction for error messages using the last successful usage", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const successfulAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: Date.now(),
		});
		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now() + 1000,
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			successfulAssistant,
			{ role: "user", content: [{ type: "text", text: "retry" }], timestamp: Date.now() + 500 },
			errorAssistant,
		];

<<<<<<< HEAD
		const runAutoCompactionSpy = stubRunAutoCompaction(harness.session);
=======
		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);
>>>>>>> upstream/main

		await checkCompaction(harness.session, errorAssistant);

		expect(runAutoCompactionSpy).toHaveBeenCalledWith("threshold", false);
	});

	it("does not trigger threshold compaction for error messages when no prior usage exists", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			errorAssistant,
		];

<<<<<<< HEAD
		const runAutoCompactionSpy = stubRunAutoCompaction(harness.session);
=======
		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);
>>>>>>> upstream/main

		await checkCompaction(harness.session, errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("does not trigger threshold compaction when only kept pre-compaction usage exists", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const preCompactionTimestamp = Date.now() - 10_000;
		const keptAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: preCompactionTimestamp,
		});

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: preCompactionTimestamp - 1000,
		});
		harness.sessionManager.appendMessage(keptAssistant);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction(
			"summary",
			firstKeptEntryId,
			keptAssistant.usage.totalTokens,
			undefined,
			false,
		);

		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "kept user" }], timestamp: preCompactionTimestamp - 1000 },
			keptAssistant,
			{ role: "user", content: [{ type: "text", text: "new prompt" }], timestamp: Date.now() - 500 },
			errorAssistant,
		];

<<<<<<< HEAD
		const runAutoCompactionSpy = stubRunAutoCompaction(harness.session);
=======
		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);
>>>>>>> upstream/main

		await checkCompaction(harness.session, errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("does not trigger threshold compaction below the threshold or when disabled", async () => {
		const belowThresholdHarness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(belowThresholdHarness);
		const disabledHarness = await createHarness({ settings: { compaction: { enabled: false } } });
		harnesses.push(disabledHarness);

<<<<<<< HEAD
		const belowThresholdSpy = stubRunAutoCompaction(belowThresholdHarness.session);
		const disabledSpy = stubRunAutoCompaction(disabledHarness.session);
=======
		const belowThresholdInternals = belowThresholdHarness.session as unknown as SessionWithCompactionInternals;
		const disabledInternals = disabledHarness.session as unknown as SessionWithCompactionInternals;
		const belowThresholdSpy = vi.spyOn(belowThresholdInternals, "_runAutoCompaction").mockResolvedValue(false);
		const disabledSpy = vi.spyOn(disabledInternals, "_runAutoCompaction").mockResolvedValue(false);
>>>>>>> upstream/main

		await checkCompaction(
			belowThresholdHarness.session,
			createAssistant(belowThresholdHarness, { stopReason: "stop", totalTokens: 1_000, timestamp: Date.now() }),
		);
		await checkCompaction(
			disabledHarness.session,
			createAssistant(disabledHarness, { stopReason: "stop", totalTokens: 1_000_000, timestamp: Date.now() }),
		);

		expect(belowThresholdSpy).not.toHaveBeenCalled();
		expect(disabledSpy).not.toHaveBeenCalled();
	});
});
