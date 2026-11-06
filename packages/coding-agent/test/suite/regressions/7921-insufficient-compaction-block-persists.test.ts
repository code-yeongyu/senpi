import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REQUIRED_COMPACTION_ERROR_MESSAGE, RequiredCompactionError } from "../../../src/index.ts";
import { createHarness, getUserTexts, type Harness } from "../harness.ts";

/**
 * code-yeongyu/oh-my-openagent#7921 case 6: when an accepted compaction produces
 * an insufficient summary while a queue is pending, the session blocks. A later
 * synthetic revision bump (model or settings change, queue mutation, extension
 * continuation, scheduled retry) cleared that blocked state and the automatic
 * continuation retried the unchanged oversized context.
 */

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

function privateMethod(session: Harness["session"], name: string): (...args: unknown[]) => unknown {
	const method: unknown = Reflect.get(session, name);
	if (typeof method !== "function") throw new Error(`Expected AgentSession.${name}`);
	return method.bind(session);
}

/**
 * Seeds a session whose compaction is accepted by the summarizer but leaves the
 * context above budget, so the execution rejects it as `would-overflow` and the
 * blocked admission state arms.
 */
async function createBlockedHarness(): Promise<{ harness: Harness; assistant: AssistantMessage }> {
	const harness = await createHarness({
		models: [{ id: "faux-large", contextWindow: 20_000, maxTokens: 4_096 }],
		settings: { compaction: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 1, speculativeEnabled: false } },
	});

	const timestamp = Date.now() - 1_000;
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "work through the todo list" }],
		timestamp: timestamp - 2,
	});
	// A prior accepted compaction boundary must exist for the blocked state to arm.
	const firstEntry = harness.sessionManager.getEntries()[0];
	if (!firstEntry) throw new Error("test setup: no seeded entry");
	harness.sessionManager.appendCompaction("prior summary", firstEntry.id, 19_000);
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "post-compaction work" }],
		timestamp: timestamp - 1,
	});
	const assistant: AssistantMessage = {
		...fauxAssistantMessage("progress note ".concat("x".repeat(120_000)), { timestamp }),
		usage: createUsage(19_500),
	};
	harness.sessionManager.appendMessage(assistant);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

	// Summaries that cannot shrink the retained context: every compaction attempt
	// is accepted by the model but rejected as would-overflow.
	harness.setResponses(
		Array.from({ length: 6 }, () => fauxAssistantMessage("insufficient summary ".concat("z".repeat(120_000)))),
	);
	return { harness, assistant };
}

describe("#7921 case 6: an insufficient accepted compaction keeps its blocked state", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("stays blocked across a synthetic revision bump with the queue intact", async () => {
		const { harness, assistant } = await createBlockedHarness();
		harnesses.push(harness);

		harness.session.agent.followUp({
			role: "user",
			content: [{ type: "text", text: "queued follow-up" }],
			timestamp: Date.now(),
		});
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);

		const checkCompaction = privateMethod(harness.session, "_checkCompaction");
		await checkCompaction(assistant, true);

		// The insufficient summary blocked this assistant.
		expect(Reflect.get(harness.session, "_blockedPostCompactionAssistant")).toBeDefined();

		const enforceBeforeProvider = privateMethod(harness.session, "_enforceCompactionBeforeProvider");
		await expect(enforceBeforeProvider(assistant, true, "pre_prompt")).rejects.toThrow(
			/Context remains above the compaction threshold/,
		);

		// A synthetic revision bump: the same call a model or settings change makes.
		const callsBeforeBump = harness.faux.state.callCount;
		privateMethod(harness.session, "_invalidateCompactionForModelSelection")();

		// The context did not change, so the block must persist.
		expect(Reflect.get(harness.session, "_blockedPostCompactionAssistant")).toBeDefined();
		await expect(enforceBeforeProvider(assistant, true, "pre_prompt")).rejects.toThrow(
			/Context remains above the compaction threshold/,
		);
		// No provider work at all: the unchanged oversized context must not be
		// re-compacted or re-sent.
		expect(harness.faux.state.callCount).toBe(callsBeforeBump);
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);
	});

	it("clears the block on manual compaction", async () => {
		const { harness, assistant } = await createBlockedHarness();
		harnesses.push(harness);

		const checkCompaction = privateMethod(harness.session, "_checkCompaction");
		await checkCompaction(assistant, true);
		expect(Reflect.get(harness.session, "_blockedPostCompactionAssistant")).toBeDefined();

		await harness.session.compact().catch(() => undefined);

		expect(Reflect.get(harness.session, "_blockedPostCompactionAssistant")).toBeUndefined();
	});

	/**
	 * A session whose automatic compaction failed after an earlier checkpoint, so the
	 * automatic-loop latch is armed; `retryAllowed` decides whether a later attempt succeeds.
	 */
	async function createLatchedHarness(): Promise<{
		harness: Harness;
		attempts: () => number;
		allowRetry: (allowed: boolean) => void;
	}> {
		let attempts = 0;
		let retryAllowed = false;
		const harness = await createHarness({
			models: [{ id: "faux-large", contextWindow: 20_000, maxTokens: 4_096 }],
			settings: {
				compaction: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 1, speculativeEnabled: false },
			},
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => {
						attempts++;
						if (!retryAllowed) return { cancel: true, reason: "summary unavailable" };
						const retained = event.branchEntries.at(-1);
						if (!retained) throw new Error("Expected a retained response");
						return {
							compaction: {
								summary: "recovered context",
								firstKeptEntryId: retained.id,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		const timestamp = Date.now() - 1_000;
		harness.sessionManager.appendMessage({ role: "user", content: "old work", timestamp });
		const first = harness.sessionManager.getEntries()[0];
		if (!first) throw new Error("Expected a seeded entry");
		harness.sessionManager.appendCompaction("prior summary", first.id, 19_000);
		harness.sessionManager.appendMessage({ role: "user", content: "x".repeat(80_000), timestamp });
		const model = harness.getModel();
		const assistant: AssistantMessage = {
			...fauxAssistantMessage("progress", { timestamp }),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: createUsage(19_500),
		};
		harness.sessionManager.appendMessage(assistant);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		const liveAssistant = harness.session.agent.state.messages.at(-1);
		if (liveAssistant?.role !== "assistant") throw new Error("Expected the live assistant response");
		await privateMethod(harness.session, "_checkCompaction")(liveAssistant, true);
		expect(attempts).toBe(1);
		expect(Reflect.get(harness.session, "_blockedPostCompactionAssistant")).toBeDefined();
		return {
			harness,
			attempts: () => attempts,
			allowRetry: (allowed) => {
				retryAllowed = allowed;
			},
		};
	}

	// senpi#4161: the automatic-loop latch must not prevent an explicit new turn from recovering.
	// A plain SDK `prompt()` with no `source`/`inputOrigin` is a person's input (`inputOriginOf`).
	it.each([true, false])("retries compaction on the next user prompt (recovery succeeds: %s)", async (recovers) => {
		const { harness, attempts, allowRetry } = await createLatchedHarness();
		harnesses.push(harness);

		allowRetry(recovers);
		harness.setResponses([fauxAssistantMessage("answered the next message")]);
		const nextPrompt = harness.session.prompt("please continue");
		if (recovers) {
			await expect(nextPrompt).resolves.toBeUndefined();
			expect(harness.faux.state.callCount).toBe(1);
			expect(getUserTexts(harness).filter((text) => text === "please continue")).toHaveLength(1);
		} else {
			// SDK callers get a typed error whose wording names no slash command.
			const rejection = await nextPrompt.then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(rejection).toBeInstanceOf(RequiredCompactionError);
			expect(rejection).toMatchObject({ code: "compaction_failed", message: REQUIRED_COMPACTION_ERROR_MESSAGE });
			expect(REQUIRED_COMPACTION_ERROR_MESSAGE).not.toMatch(/\/\w/);
			expect(harness.faux.state.callCount).toBe(0);
			expect(getUserTexts(harness)).not.toContain("please continue");
		}
		expect(attempts()).toBe(2);
		expect(harness.session.isCompacting).toBe(false);
		expect(harness.session.isStreaming).toBe(false);
	});

	// An extension-sent prompt is automation, not a person: it keeps the latch and is refused without a retry.
	it("keeps the latch for an extension-sourced prompt", async () => {
		const { harness, attempts, allowRetry } = await createLatchedHarness();
		harnesses.push(harness);

		allowRetry(true);
		await expect(harness.session.prompt("automated nudge", { source: "extension" })).rejects.toBeInstanceOf(
			RequiredCompactionError,
		);
		expect(attempts()).toBe(1);
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("clears the block once a real compaction reduces the context", async () => {
		const { harness, assistant } = await createBlockedHarness();
		harnesses.push(harness);

		const checkCompaction = privateMethod(harness.session, "_checkCompaction");
		await checkCompaction(assistant, true);
		expect(Reflect.get(harness.session, "_blockedPostCompactionAssistant")).toBeDefined();

		// A compaction that actually shrinks the context releases the block.
		const retained = harness.sessionManager.getEntries().at(-1);
		if (!retained) throw new Error("test setup: no retained entry");
		harness.sessionManager.appendCompaction("effective summary", retained.id, 19_500);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		privateMethod(harness.session, "_incrementMessageRevision")();

		expect(Reflect.get(harness.session, "_blockedPostCompactionAssistant")).toBeUndefined();
	});
});
