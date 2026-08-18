import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	createDegradationMonitorState,
	handleMessageEnd,
	RECOVERY_INSTRUCTIONS,
} from "../../src/core/extensions/builtin/compaction/degradation-monitor.ts";
import { MAX_SUMMARIZATION_ATTEMPT_RETRIES } from "../../src/core/extensions/builtin/compaction/summarization-retry.ts";
import type { ModelSelectEvent } from "../../src/core/extensions/index.ts";
import {
	connectionErrorResponse,
	createBeforeAgentStartEvent,
	createBlockingContext,
	createCompactionHandlers,
} from "../helpers/blocking-compaction-harness.ts";

/** One summarization now costs its initial attempt plus the shared retry budget. */
const SUMMARIZATION_ATTEMPTS = 1 + MAX_SUMMARIZATION_ATTEMPT_RETRIES;

const registrations: Array<{ unregister: () => void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

function noTextAssistantEvent() {
	return { message: { role: "assistant", content: [{ type: "toolCall" }] } };
}

async function driveRecovery(applyResult: { applied: boolean; reason: string }): Promise<string[]> {
	const state = createDegradationMonitorState();
	state.postCompactionTurnsRemaining = 5;
	const notifications: string[] = [];
	const context = {
		applyCompaction: async (options: { customInstructions: string }) => {
			expect(options.customInstructions).toBe(RECOVERY_INSTRUCTIONS);
			return applyResult;
		},
		notify: (message: string) => {
			notifications.push(message);
		},
	};
	for (let i = 0; i < 3; i++) {
		await handleMessageEnd(state, noTextAssistantEvent(), context);
	}
	return notifications;
}

describe("blocking compaction review hardening", () => {
	describe("Given a provider refusal whose text looks transient", () => {
		it("Then blocking compaction still surfaces it loudly", async () => {
			// Given: refusal metadata must win over retryable-looking message text.
			const { beforeAgentStart } = createCompactionHandlers();
			const harness = createBlockingContext({ usageTokens: 9_950 });
			registrations.push(harness.registration);
			harness.registration.setResponses([
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "Refused. You can retry your request with different content.",
					stopDetails: { type: "refusal" },
				}),
			]);

			// When / Then
			await expect(beforeAgentStart(createBeforeAgentStartEvent(), harness.ctx)).rejects.toThrow(
				"retry your request",
			);
		});
	});

	describe("Given the breaker tripped from repeated transient failures", () => {
		it("Then a window-shrink model_select does not start a speculative summary", async () => {
			// Given: three transient blocking failures trip the breaker.
			const handlers = createCompactionHandlers();
			const harness = createBlockingContext({ usageTokens: 6_000 });
			registrations.push(harness.registration);
			harness.registration.setResponses(
				Array.from({ length: 3 * SUMMARIZATION_ATTEMPTS }, () => connectionErrorResponse()),
			);
			for (let attempt = 0; attempt < 3; attempt++) {
				await expect(
					handlers.beforeAgentStart(createBeforeAgentStartEvent(), harness.ctx),
				).resolves.toBeUndefined();
			}
			harness.getApiKeyAndHeaders.mockClear();
			harness.setUsageTokens(120_000);

			// When: the model window shrinks while cooling down.
			await handlers.modelSelect(shrinkEvent(harness.ctx.model), harness.ctx);

			// Then: no summarization credentials are even resolved.
			expect(harness.getApiKeyAndHeaders).not.toHaveBeenCalled();
		});

		it("Then a window-shrink model_select still warms up when the breaker is closed", async () => {
			// Given
			const handlers = createCompactionHandlers();
			const harness = createBlockingContext({ usageTokens: 120_000 });
			registrations.push(harness.registration);
			harness.registration.setResponses([fauxAssistantMessage("warm summary")]);

			// When
			await handlers.modelSelect(shrinkEvent(harness.ctx.model), harness.ctx);

			// Then
			expect(harness.getApiKeyAndHeaders).toHaveBeenCalledTimes(1);
		});
	});

	describe("Given blocking compaction is aborted by its feedback signal", () => {
		it("Then it degrades silently with no error message", async () => {
			// Given
			const { beforeAgentStart } = createCompactionHandlers();
			const controller = new AbortController();
			controller.abort();
			const harness = createBlockingContext({ usageTokens: 9_950, beginCompaction: () => controller.signal });
			registrations.push(harness.registration);
			harness.registration.setResponses([fauxAssistantMessage("never used")]);

			// When / Then
			await expect(beforeAgentStart(createBeforeAgentStartEvent(), harness.ctx)).resolves.toBeUndefined();
			expect(errorMessages(harness.endCompaction)).toHaveLength(0);
		});
	});

	describe("Given the summarization response has no text", () => {
		it("Then blocking compaction surfaces the unavailable reason", async () => {
			// Given
			const { beforeAgentStart } = createCompactionHandlers();
			const harness = createBlockingContext({ usageTokens: 9_950 });
			registrations.push(harness.registration);
			harness.registration.setResponses([fauxAssistantMessage("", { stopReason: "stop" })]);

			// When / Then: the concrete reason is surfaced instead of the bare generic
			// message (issue #765), so the failure is diagnosable after the fact.
			await expect(beforeAgentStart(createBeforeAgentStartEvent(), harness.ctx)).resolves.toBeUndefined();
			expect(
				errorMessages(harness.endCompaction).map((call) => (call as [{ errorMessage: string }])[0].errorMessage),
			).toEqual(["Compaction did not apply: unavailable"]);
		});
	});

	describe("Given degradation recovery hits a transient compaction failure", () => {
		it("Then no recovery notification stacks on the compaction error surface", async () => {
			// When: recovery compaction reports a failed (already-surfaced) result.
			const notifications = await driveRecovery({ applied: false, reason: "failed" });

			// Then: compaction_end's errorMessage stays the single surface.
			expect(notifications).toHaveLength(0);
		});

		it("Then unavailable results keep notifying as before", async () => {
			// When
			const notifications = await driveRecovery({ applied: false, reason: "unavailable" });

			// Then
			expect(notifications).toHaveLength(1);
		});
	});
});

function shrinkEvent(model: ModelSelectEvent["model"] | undefined): ModelSelectEvent {
	if (!model) throw new Error("harness model missing");
	return {
		type: "model_select",
		model,
		previousModel: { ...model, contextWindow: 1_000_000 },
		source: "set",
		systemPrompt: "system",
		systemPromptOptions: Object.create(null) as ModelSelectEvent["systemPromptOptions"],
	};
}

function errorMessages(endCompaction: { mock: { calls: unknown[][] } }): unknown[] {
	return endCompaction.mock.calls.filter((call) => {
		const first = call[0];
		return typeof first === "object" && first !== null && typeof Reflect.get(first, "errorMessage") === "string";
	});
}
