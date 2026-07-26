import { setImmediate as waitForImmediate } from "node:timers/promises";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/index.ts";
import { COMPACTION_SUMMARY_PREFIX } from "../../src/core/messages.ts";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

type Deferred = {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
};

type BeginFeedback = (reason: "extension") => AbortSignal;
type EndFeedback = (options: {
	reason: "extension";
	signal?: AbortSignal;
	aborted?: boolean;
	errorMessage?: string;
}) => void;

type TextBlock = {
	readonly type: "text";
	readonly text?: string;
};

function createDeferred(): Deferred {
	let resolve: (() => void) | undefined;
	const promise = new Promise<void>((next) => {
		resolve = next;
	});
	if (!resolve) {
		throw new Error("Deferred resolver was not initialized");
	}
	return { promise, resolve };
}

async function waitForProviderDispatch(): Promise<void> {
	await Promise.resolve();
	await waitForImmediate();
}

async function waitForCompactionStart(deferred: Deferred): Promise<void> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			deferred.promise,
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => reject(new Error("Timed out waiting for compaction to start")), 1000);
			}),
		]);
	} finally {
		if (timeout) {
			clearTimeout(timeout);
		}
	}
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise.then(() => true),
			new Promise<boolean>((resolve) => {
				timeout = setTimeout(() => resolve(false), timeoutMs);
			}),
		]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

function getRunAutoCompaction(harness: Harness) {
	const runAutoCompaction = Reflect.get(harness.session, "_runAutoCompaction");
	if (typeof runAutoCompaction !== "function") {
		throw new Error("Expected AgentSession._runAutoCompaction");
	}
	return (reason: "overflow" | "threshold", willRetry: boolean): Promise<boolean> =>
		Promise.resolve(runAutoCompaction.call(harness.session, reason, willRetry));
}

function createBlockingCompactionExtension(started: Deferred, release: Deferred, summary: string) {
	return (pi: ExtensionAPI): void => {
		pi.on("session_before_compact", async (event) => {
			started.resolve();
			await release.promise;

			return {
				compaction: {
					summary,
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
				},
			};
		});
	};
}

function isTextBlock(block: unknown): block is TextBlock {
	if (!block || typeof block !== "object" || !("type" in block) || block.type !== "text") {
		return false;
	}
	if (!("text" in block) || block.text === undefined) {
		return true;
	}
	return typeof block.text === "string";
}

function getTextBlocks(contextMessage: unknown): readonly TextBlock[] {
	if (!contextMessage || typeof contextMessage !== "object" || !("content" in contextMessage)) {
		return [];
	}
	const { content } = contextMessage;
	if (!Array.isArray(content)) {
		return [];
	}
	return content.filter(isTextBlock);
}

function hasCompactionSummary(contextMessage: unknown, summary: string): boolean {
	const content = getTextBlocks(contextMessage);
	if (content.length === 0) {
		return false;
	}
	return content.some(
		(block) => block.text?.includes(COMPACTION_SUMMARY_PREFIX) === true && block.text.includes(summary),
	);
}

function contextHasText(contextMessage: unknown, text: string): boolean {
	const content = getTextBlocks(contextMessage);
	if (content.length === 0) {
		return false;
	}
	return content.some((block) => block.text?.includes(text) === true);
}

describe("AgentSession compaction race handling", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("given compaction is in progress when a new prompt arrives, when compaction finishes, then the prompt starts after compacted history", async () => {
		// given
		const compactionStarted = createDeferred();
		const releaseCompaction = createDeferred();
		const initialPrompt = "initial prompt ".repeat(120);
		const harness = await createHarness({
			models: [{ id: "tiny-context", contextWindow: 128, maxTokens: 64 }],
			settings: { compaction: { enabled: true, reserveTokens: 64, keepRecentTokens: 1 } },
			extensionFactories: [
				createBlockingCompactionExtension(compactionStarted, releaseCompaction, "slow threshold summary"),
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("initial assistant"), fauxAssistantMessage("second assistant")]);

		const firstPrompt = harness.session.prompt(initialPrompt);
		await waitForCompactionStart(compactionStarted);
		expect(harness.session.isCompacting).toBe(true);

		// when
		const secondPrompt = harness.session.prompt("prompt during compaction");
		try {
			await waitForProviderDispatch();

			// then
			expect(harness.faux.state.callCount, "new prompt must not reach provider before compaction settles").toBe(1);
		} finally {
			releaseCompaction.resolve();
			await Promise.allSettled([firstPrompt, secondPrompt]);
		}

		expect(harness.faux.state.callCount).toBe(2);
		const secondCall = harness.faux.getCallLog()[1];
		expect(
			secondCall?.context.messages.some((message) => hasCompactionSummary(message, "slow threshold summary")),
		).toBe(true);
		expect(secondCall?.context.messages.some((message) => contextHasText(message, initialPrompt))).toBe(false);
		expect(getUserTexts(harness)).toEqual(["prompt during compaction"]);
	});

	it("given overflow compaction has a queued follow-up when a new prompt arrives, when recovery finishes, then queued messages drain before the new prompt", async () => {
		// given
		const compactionStarted = createDeferred();
		const releaseCompaction = createDeferred();
		const harness = await createHarness({
			models: [{ id: "normal-context", contextWindow: 128_000, maxTokens: 16 }],
			settings: {
				compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 1 },
				retry: { enabled: false },
			},
			extensionFactories: [
				createBlockingCompactionExtension(compactionStarted, releaseCompaction, "slow overflow summary"),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("pre-overflow assistant"),
			fauxAssistantMessage("overflow retry recovered"),
			fauxAssistantMessage("queued follow-up recovered"),
			fauxAssistantMessage("fresh prompt recovered"),
		]);

		await harness.session.prompt("overflow prompt");
		await harness.session.followUp("queued during overflow");
		const runAutoCompaction = Reflect.get(harness.session, "_runAutoCompaction");
		if (typeof runAutoCompaction !== "function") {
			throw new Error("Expected AgentSession._runAutoCompaction");
		}

		const overflowPrompt = Promise.resolve(runAutoCompaction.call(harness.session, "overflow", true));
		await waitForCompactionStart(compactionStarted);

		// when
		const freshPrompt = harness.session.prompt("fresh prompt during overflow compaction");
		try {
			await waitForProviderDispatch();

			// then
			expect(harness.faux.state.callCount, "fresh prompt must wait for overflow recovery").toBe(1);
		} finally {
			releaseCompaction.resolve();
			await Promise.allSettled([overflowPrompt, freshPrompt]);
		}

		expect(harness.faux.state.callCount).toBe(3);
		const recoveryCall = harness.faux.getCallLog()[1];
		expect(
			recoveryCall?.context.messages.some((message) => hasCompactionSummary(message, "slow overflow summary")),
		).toBe(true);
		expect(recoveryCall?.context.messages.some((message) => contextHasText(message, "queued during overflow"))).toBe(
			true,
		);
		const freshCall = harness.faux.getCallLog()[2];
		expect(
			freshCall?.context.messages.some((message) =>
				contextHasText(message, "fresh prompt during overflow compaction"),
			),
		).toBe(true);
		expect(getUserTexts(harness)).toEqual(["queued during overflow", "fresh prompt during overflow compaction"]);
	});

	it("given compaction has no concurrent prompt, when it completes, then the next prompt still runs without waiting on a stale barrier", async () => {
		// given
		const compactionStarted = createDeferred();
		const releaseCompaction = createDeferred();
		const initialPrompt = "initial prompt ".repeat(120);
		const harness = await createHarness({
			models: [{ id: "tiny-context", contextWindow: 128, maxTokens: 64 }],
			settings: { compaction: { enabled: true, reserveTokens: 64, keepRecentTokens: 1 } },
			extensionFactories: [
				createBlockingCompactionExtension(compactionStarted, releaseCompaction, "normal threshold summary"),
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("initial assistant"), fauxAssistantMessage("after compaction")]);

		const firstPrompt = harness.session.prompt(initialPrompt);
		await waitForCompactionStart(compactionStarted);

		// when
		releaseCompaction.resolve();
		await firstPrompt;
		await harness.session.prompt("after compaction prompt");

		// then
		expect(harness.faux.state.callCount).toBe(2);
		const secondCall = harness.faux.getCallLog()[1];
		expect(
			secondCall?.context.messages.some((message) => hasCompactionSummary(message, "normal threshold summary")),
		).toBe(true);
		expect(secondCall?.context.messages.some((message) => contextHasText(message, initialPrompt))).toBe(false);
		expect(getUserTexts(harness)).toEqual(["after compaction prompt"]);
	});

	it("aborts an active run before manual compaction disconnects the agent-event subscription", async () => {
		const eventOrder: string[] = [];
		let resolveStreamingUpdate: (() => void) | undefined;
		const streamingUpdate = new Promise<void>((resolve) => {
			resolveStreamingUpdate = resolve;
		});
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "manual compaction after active abort",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("first seed response"),
			fauxAssistantMessage("second seed response"),
			fauxAssistantMessage("streaming response ".repeat(4_000)),
		]);
		await harness.session.prompt("first seed prompt");
		await harness.session.prompt("second seed prompt");

		harness.session.subscribe((event) => {
			if (event.type === "message_update" && event.message.role === "assistant") {
				resolveStreamingUpdate?.();
				resolveStreamingUpdate = undefined;
			}
			if (event.type === "agent_end") eventOrder.push("agent_end");
			if (event.type === "compaction_start") eventOrder.push("compaction_start");
		});

		const activePrompt = harness.session.prompt("prompt whose provider stream is active");
		await streamingUpdate;
		expect(harness.session.isStreaming).toBe(true);

		const manualCompaction = harness.session.compact();
		const settled = await settlesWithin(Promise.allSettled([activePrompt, manualCompaction]), 1_000);
		expect(settled, "manual compaction must not deadlock behind an aborted active run").toBe(true);
		if (!settled) return;

		const activeAgentEnd = harness.eventsOfType("agent_end").at(-1);
		expect(activeAgentEnd?.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
		expect(eventOrder).toEqual(expect.arrayContaining(["agent_end", "compaction_start"]));
		expect(eventOrder.indexOf("agent_end")).toBeLessThan(eventOrder.indexOf("compaction_start"));
		expect(harness.session.isStreaming).toBe(false);
		expect(harness.session.isCompacting).toBe(false);

		harness.setResponses([fauxAssistantMessage("later prompt succeeded")]);
		await harness.session.prompt("later prompt after manual compaction");
		expect(getUserTexts(harness).at(-1)).toBe("later prompt after manual compaction");
		expect(harness.session.isStreaming).toBe(false);
		expect(harness.session.isCompacting).toBe(false);
	});

	it("settles an active stream before extension-context compaction starts", async () => {
		const eventOrder: string[] = [];
		const extensionCompactionEnded = createDeferred();
		let extensionContext: ExtensionContext | undefined;
		let resolveStreamingUpdate: (() => void) | undefined;
		const streamingUpdate = new Promise<void>((resolve) => {
			resolveStreamingUpdate = resolve;
		});
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, ctx) => {
						extensionContext = ctx;
					});
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "extension-context compaction after active abort",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		if (!extensionContext) throw new Error("Expected session_start extension context");

		harness.setResponses([
			fauxAssistantMessage("first seed response"),
			fauxAssistantMessage("second seed response"),
			fauxAssistantMessage("streaming response ".repeat(4_000)),
		]);
		await harness.session.prompt("first seed prompt");
		await harness.session.prompt("second seed prompt");

		harness.session.subscribe((event) => {
			if (event.type === "message_update" && event.message.role === "assistant") {
				resolveStreamingUpdate?.();
				resolveStreamingUpdate = undefined;
			}
			if (event.type === "agent_end") eventOrder.push("agent_end");
			if (event.type === "compaction_start") eventOrder.push("compaction_start");
			if (event.type === "compaction_end" && event.reason === "extension") extensionCompactionEnded.resolve();
		});

		const activePrompt = harness.session.prompt("prompt whose provider stream is active");
		await streamingUpdate;
		expect(harness.session.isStreaming).toBe(true);

		// Exercise the actual ctx.compact() binding rather than AgentSession.compact().
		extensionContext.compact();
		const settled = await settlesWithin(Promise.allSettled([activePrompt, extensionCompactionEnded.promise]), 1_000);
		expect(settled, "extension compaction must not deadlock behind an aborted active run").toBe(true);
		if (!settled) return;
		await harness.session.waitForSettledSessionWork();

		const activeAgentEnd = harness.eventsOfType("agent_end").at(-1);
		expect(activeAgentEnd?.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
		expect(eventOrder.indexOf("agent_end")).toBeGreaterThanOrEqual(0);
		expect(eventOrder.indexOf("compaction_start")).toBeGreaterThan(eventOrder.indexOf("agent_end"));
		expect(harness.session.isStreaming).toBe(false);
		expect(harness.session.isCompacting).toBe(false);

		harness.setResponses([fauxAssistantMessage("later prompt succeeded")]);
		await harness.session.prompt("later prompt after extension compaction");
		expect(getUserTexts(harness).at(-1)).toBe("later prompt after extension compaction");
		expect(harness.session.isStreaming).toBe(false);
		expect(harness.session.isCompacting).toBe(false);
	});

	it("auto compaction supersedes unrelated extension feedback without promoting it", async () => {
		// RED 1: an active extension feedback operation owns neither the auto
		// compaction that starts underneath it nor the final terminal event. The
		// auto operation must supersede/abort the stale feedback operation instead
		// of promoting or reusing its controller: the stale feedback end must not
		// publish a terminal, the matching outer controller must still clear, and
		// the auto compaction must complete exactly once.
		const compactionStarted = createDeferred();
		const releaseCompaction = createDeferred();
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 16_384 } },
			extensionFactories: [
				createBlockingCompactionExtension(compactionStarted, releaseCompaction, "auto threshold summary"),
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("seed response")]);
		await harness.session.prompt("seed context ".repeat(40));
		harness.events.length = 0;

		const begin = Reflect.get(harness.session, "_beginExtensionCompactionFeedback");
		const end = Reflect.get(harness.session, "_endExtensionCompactionFeedback");
		if (typeof begin !== "function" || typeof end !== "function") {
			throw new Error("Compaction feedback lifecycle methods unavailable");
		}

		const staleFeedbackSignal = (begin as BeginFeedback).call(harness.session, "extension");
		expect(harness.session.isCompacting).toBe(true);
		expect(harness.session.compactionState).toMatchObject({
			status: "running",
			generation: 1,
			stage: "feedback",
		});

		const autoCompaction = getRunAutoCompaction(harness)("threshold", false);
		await compactionStarted.promise;
		try {
			// The auto compaction runs on its own controller: it supersedes the
			// unrelated feedback operation rather than promoting or reusing it.
			expect(staleFeedbackSignal.aborted).toBe(true);
			expect(harness.session.compactionState).toMatchObject({
				status: "running",
				generation: 2,
				stage: "execution",
			});
		} finally {
			releaseCompaction.resolve();
		}
		await autoCompaction;
		await harness.session.waitForSettledSessionWork();

		// The stale feedback end publishes no terminal of its own: the auto
		// completion is the final lifecycle terminal, with no duplicate
		// compaction entry appended and no duplicate terminal event.
		(end as EndFeedback).call(harness.session, {
			reason: "extension",
			signal: staleFeedbackSignal,
			errorMessage: "stale feedback ended after auto compaction",
		});
		expect(harness.session.compactionState).toMatchObject({ status: "completed", generation: 2 });
		expect(harness.session.isCompacting).toBe(false);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(2);
		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({ reason: "threshold", accepted: true, aborted: false }),
		]);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});

	it("does not let an auto-compaction admitted before auth supersede a manual compaction", async () => {
		const autoAuthStarted = createDeferred();
		const releaseAutoAuth = createDeferred();
		const harness = await createHarness({
			models: [{ id: "auto-auth-race", contextWindow: 128_000, maxTokens: 64 }],
			settings: { compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "manual wins auto-auth race",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("seed response")]);
		await harness.session.prompt("seed context ".repeat(40));
		harness.events.length = 0;

		const lifecycle = Reflect.get(harness.session, "_compactionLifecycle") as {
			begin: (...args: never[]) => unknown;
		};
		const lifecycleBegin = vi.spyOn(lifecycle, "begin");
		const modelRuntime = Reflect.get(harness.session, "_modelRuntime") as {
			getAuth: (...args: unknown[]) => Promise<unknown>;
		};
		const originalGetAuth = modelRuntime.getAuth.bind(modelRuntime);
		vi.spyOn(modelRuntime, "getAuth").mockImplementation(async (...args) => {
			autoAuthStarted.resolve();
			await releaseAutoAuth.promise;
			return await originalGetAuth(...args);
		});

		const autoCompaction = getRunAutoCompaction(harness)("threshold", false);
		await autoAuthStarted.promise;
		const manualCompaction = harness.session.compact();
		await manualCompaction;
		releaseAutoAuth.resolve();
		expect(await autoCompaction).toBe(false);
		await harness.session.waitForSettledSessionWork();

		// The auto attempt was superseded while auth was pending. It owns no
		// lifecycle transition or public events; the manual operation completes once.
		expect(lifecycleBegin).toHaveBeenCalledTimes(1);
		expect(harness.eventsOfType("compaction_start")).toEqual([expect.objectContaining({ reason: "manual" })]);
		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({ reason: "manual", accepted: true, aborted: false }),
		]);
		expect(harness.session.compactionState).toMatchObject({ status: "completed" });
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});
});
