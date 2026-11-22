import type { AgentMessage, QueuedInputPort } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PendingInputAppendUncertainError } from "../../../src/core/pending-input-journal.ts";
import { registerFallbackModels } from "../fallback-provider-fixture.ts";
import { createHarness, type Harness } from "../harness.ts";

// senpi#3866 (omo#10781): on Windows the pending-input journal's fsync failed with EPERM while a queued input's
// consumption was committed. The run failure was taken for a model hard error, and the session walked its whole
// fallback chain in under a second and stayed on the last model. A local failure must leave the model alone.

const SESSION_FILE = "/sessions/2026-10-21/session.jsonl";

function eperm(): NodeJS.ErrnoException {
	return Object.assign(new Error("EPERM: operation not permitted, fsync"), { code: "EPERM", syscall: "fsync" });
}

function edquot(): NodeJS.ErrnoException {
	return Object.assign(new Error("EDQUOT: disk quota exceeded, fsync"), { code: "EDQUOT", syscall: "fsync" });
}

type HealthInternals = { _retryFallback: { noteHealthFailure: (...args: unknown[]) => void } };

function failingJournalPort(cause: NodeJS.ErrnoException = eperm()): QueuedInputPort {
	return {
		claim: async (_queue, drain) => drain(),
		release: async (_queue, _messages, giveBack) => {
			giveBack.restore();
		},
		commitConsumption: async () => {
			throw new PendingInputAppendUncertainError(2, SESSION_FILE, cause);
		},
	};
}

function lastAssistant(messages: readonly AgentMessage[]): AssistantMessage | undefined {
	return messages.findLast((message): message is AssistantMessage => message.role === "assistant");
}

describe("senpi#3866: a local failure during a turn is not a model failure", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("never retries or falls back, keeps the model, and reports the failure as local with its path", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: {
					enabled: true,
					maxRetries: 3,
					baseDelayMs: 1,
					fallbackChains: { "faux/faux-1": ["other-faux/faux-2"] },
				},
			},
		});
		harnesses.push(harness);
		registerFallbackModels(harness, "other-faux", ["faux-2"]);
		const noteHealthFailure = vi.spyOn(
			(harness.session as unknown as HealthInternals)._retryFallback,
			"noteHealthFailure",
		);
		harness.agent.queuedInputPort = failingJournalPort();
		harness.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("must not be requested")]);
		harness.agent.followUp({ role: "user", content: [{ type: "text", text: "continue" }], timestamp: Date.now() });

		await harness.session.prompt("hello");

		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1"]);
		expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		expect(noteHealthFailure).not.toHaveBeenCalled();
		expect(`${harness.session.model?.provider}/${harness.session.model?.id}`).toBe("faux/faux-1");
		const failure = lastAssistant(harness.session.messages);
		expect(failure?.stopReason).toBe("error");
		expect(failure?.failureSource).toBe("local");
		expect(failure?.errorMessage).toContain(SESSION_FILE);
		expect(failure?.errorMessage).toContain("EPERM");
	});

	it("never reports the model unhealthy when a local failure's OS text reads like a quota limit", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: {
					enabled: true,
					maxRetries: 3,
					baseDelayMs: 1,
					fallbackChains: { "faux/faux-1": ["other-faux/faux-2"] },
				},
			},
		});
		harnesses.push(harness);
		registerFallbackModels(harness, "other-faux", ["faux-2"]);
		const noteHealthFailure = vi.spyOn(
			(harness.session as unknown as HealthInternals)._retryFallback,
			"noteHealthFailure",
		);
		harness.agent.queuedInputPort = failingJournalPort(edquot());
		harness.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("must not be requested")]);
		harness.agent.followUp({ role: "user", content: [{ type: "text", text: "continue" }], timestamp: Date.now() });

		await harness.session.prompt("hello");

		expect(lastAssistant(harness.session.messages)?.errorMessage).toContain("EDQUOT: disk quota exceeded");
		expect(noteHealthFailure).not.toHaveBeenCalled();
		expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
		expect(`${harness.session.model?.provider}/${harness.session.model?.id}`).toBe("faux/faux-1");
	});

	it("still falls back when the provider itself fails (control)", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: {
					enabled: true,
					maxRetries: 0,
					baseDelayMs: 1,
					fallbackChains: { "faux/faux-1": ["other-faux/faux-2"] },
				},
			},
		});
		harnesses.push(harness);
		registerFallbackModels(harness, "other-faux", ["faux-2"]);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "billing error: insufficient_quota" }),
			fauxAssistantMessage("fallback answer"),
		]);

		await harness.session.prompt("hello");

		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-2"]);
		expect(harness.eventsOfType("retry_fallback_applied")).toHaveLength(1);
	});
});
