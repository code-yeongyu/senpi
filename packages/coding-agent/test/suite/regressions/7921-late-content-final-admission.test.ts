import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

/**
 * code-yeongyu/oh-my-openagent#7921 case 5: content that arrives after the
 * pre-prompt admission projection has run - oversized steering queued late, or
 * a large fresh tool result appended after an accepted compaction - reached the
 * provider unvalidated, because the final gate measured only the messages it was
 * handed and because the stale-usage exemption skipped the whole estimate rather
 * than only the usage number that predates the compaction boundary.
 */

const OVERSIZED_STEER = "X".repeat(60_000);

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

function createAssistant(harness: Harness, totalTokens: number, text: string, timestamp: number): AssistantMessage {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage(text, { stopReason: "stop", timestamp }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(totalTokens),
	};
}

function requestCarries(harness: Harness, needle: string): boolean[] {
	return harness.faux.getCallLog().map((call) => JSON.stringify(call.context.messages).includes(needle));
}

describe("#7921 case 5: the final admission revalidates late content", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("does not send a request carrying steering queued after the admission projection ran", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 10_000, maxTokens: 1_000 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1_000 } },
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						// Steering that lands after the pre-prompt preflight already
						// sampled the context, i.e. exactly the late-arrival window.
						void harness.session.steer(OVERSIZED_STEER);
						return undefined;
					});
				},
			],
		});
		harnesses.push(harness);

		const now = Date.now();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "earlier prompt" }],
			timestamp: now - 3_000,
		});
		harness.sessionManager.appendMessage(createAssistant(harness, 2_000, "earlier response", now - 2_000));
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		harness.setResponses([
			fauxAssistantMessage("summary"),
			fauxAssistantMessage("first"),
			fauxAssistantMessage("second"),
			fauxAssistantMessage("third"),
		]);

		await harness.session.prompt("user prompt").catch(() => undefined);
		await harness.session.waitForIdle();

		const carried = requestCarries(harness, OVERSIZED_STEER);
		const firstCarryingIndex = carried.indexOf(true);
		if (firstCarryingIndex !== -1) {
			// If it is ever admitted, a compaction must have been attempted first.
			expect(harness.eventsOfType("compaction_start").length).toBeGreaterThan(0);
		}
		// Fail closed: the oversized late steer must not ride into the very first
		// provider request of this turn.
		expect(carried[0]).toBe(false);
	});

	it("revalidates a fresh oversized tool result appended after an accepted compaction", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 10_000, maxTokens: 1_000 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1_000 } },
		});
		harnesses.push(harness);

		const now = Date.now();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "old prompt" }],
			timestamp: now - 5_000,
		});
		const staleAssistant = createAssistant(harness, 9_500, "old response", now - 4_000);
		harness.sessionManager.appendMessage(staleAssistant);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]?.id;
		if (!firstKeptEntryId) throw new Error("test setup: no seeded entry to keep");
		harness.sessionManager.appendCompaction("summary", firstKeptEntryId, 9_500, undefined, false);

		const freshToolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "tool-1",
			toolName: "bash",
			content: [{ type: "text", text: "Y".repeat(80_000) }],
			isError: false,
			timestamp: now,
		};
		harness.sessionManager.appendMessage(freshToolResult);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		// The context is now ~80k estimated tokens against a 10k window: the only
		// thing that predates the compaction boundary is the stale usage number.
		const usage = harness.session.getContextUsage();
		expect(usage?.tokens ?? 0).toBeGreaterThan(10_000);

		const getAutoCompactionReason = Reflect.get(harness.session, "_getAutoCompactionReason");
		const checkCompaction = Reflect.get(harness.session, "_checkCompaction");
		if (typeof getAutoCompactionReason !== "function" || typeof checkCompaction !== "function") {
			throw new Error("AgentSession compaction internals are not available");
		}

		expect(getAutoCompactionReason.call(harness.session, staleAssistant)).toBe("threshold");

		harness.setResponses([fauxAssistantMessage("summary")]);
		await checkCompaction.call(harness.session, staleAssistant);
		expect(harness.eventsOfType("compaction_start").length).toBeGreaterThan(0);
	});
});
