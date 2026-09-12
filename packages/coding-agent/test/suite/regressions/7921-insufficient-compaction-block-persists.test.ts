import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

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
