import { setImmediate as waitForImmediate } from "node:timers/promises";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/index.ts";
import { COMPACTION_SUMMARY_PREFIX } from "../../src/core/messages.ts";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

type Deferred = {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
};

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
		expect(getUserTexts(harness)).toEqual([initialPrompt, "prompt during compaction"]);
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
		expect(getUserTexts(harness)).toEqual([initialPrompt, "after compaction prompt"]);
	});
});
