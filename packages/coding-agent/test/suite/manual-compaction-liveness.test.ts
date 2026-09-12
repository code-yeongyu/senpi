import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/index.ts";
import { createHarness, getAssistantTexts, type Harness } from "./harness.ts";

type Deferred = {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
};

function createDeferred(): Deferred {
	let resolve: (() => void) | undefined;
	const promise = new Promise<void>((next) => {
		resolve = next;
	});
	if (!resolve) throw new Error("Deferred resolver was not initialized");
	return { promise, resolve };
}

async function waitForSignal(signal: Promise<void>, label: string): Promise<void> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			signal,
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 1_000);
			}),
		]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

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

function createLargeResultExtension(toolResult: string, summary: string) {
	return (pi: ExtensionAPI): void => {
		pi.registerTool({
			name: "large_result",
			label: "Large Result",
			description: "Return text that requires next-turn compaction",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: toolResult }],
				details: {},
			}),
		});
		pi.on("session_before_compact", (event) => ({
			compaction: {
				summary,
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				details: {},
			},
		}));
	};
}

describe("manual compaction liveness", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("keeps a post-compaction continuation alive when redundant manual compaction has no work", async () => {
		const continuationUpdate = createDeferred();
		const contextWindow = 5_000;
		const reserveTokens = 1_000;
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow }],
			settings: {
				compaction: { enabled: true, keepRecentTokens: 1, reserveTokens },
			},
			extensionFactories: [createLargeResultExtension("tool output ".repeat(300), "post-tool compaction summary")],
		});
		harnesses.push(harness);

		const model = harness.getModel();
		const seedTimestamp = Date.now() - 2_000;
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "prior context ".repeat(220) }],
			timestamp: seedTimestamp,
		});
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("prior response", { timestamp: seedTimestamp + 1_000 }),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: createUsage(700),
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		let autoCompactionAccepted = false;
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.reason === "threshold" && event.accepted === true) {
				autoCompactionAccepted = true;
			}
			if (autoCompactionAccepted && event.type === "message_update" && event.message.role === "assistant") {
				continuationUpdate.resolve();
			}
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("continuation survived redundant compaction ".repeat(4_000)),
		]);

		const activePrompt = harness.session.prompt("run the large result tool");
		await waitForSignal(continuationUpdate.promise, "the post-compaction continuation");
		expect(harness.session.isStreaming).toBe(true);

		const manualOutcome = harness.session.compact().then(
			() => "completed" as const,
			() => "rejected" as const,
		);
		await Promise.all([activePrompt, manualOutcome]);

		const agentEnds = harness.eventsOfType("agent_end");
		const finalMessages = agentEnds[agentEnds.length - 1]?.messages ?? [];
		expect(
			finalMessages[finalMessages.length - 1],
			"a redundant manual compaction must not abort the active continuation",
		).toMatchObject({ role: "assistant", stopReason: "stop" });
		expect(harness.eventsOfType("compaction_start").map((event) => event.reason)).toEqual(["threshold", "manual"]);
		expect(harness.eventsOfType("compaction_end")[1]).toMatchObject({
			reason: "manual",
			result: undefined,
			aborted: false,
		});
		const assistantTexts = getAssistantTexts(harness);
		expect(assistantTexts[assistantTexts.length - 1]).toContain("continuation survived redundant compaction");
	});
});
