import { afterEach, describe, expect, it, vi } from "vitest";
import { RetryStatusIndicator } from "../../src/modes/interactive/components/status-indicator.ts";
import {
	assistantFailure,
	createPresentationHarness,
	providerEnvelope,
} from "./provider-error-presentation-harness.ts";

describe("provider failure presentation (#1874)", () => {
	const harnesses: ReturnType<typeof createPresentationHarness>[] = [];
	function setup() {
		vi.useFakeTimers();
		const harness = createPresentationHarness();
		harnesses.push(harness);
		return harness;
	}
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.dispose();
		vi.useRealTimers();
	});

	it("keeps seventeen summary retries out of the transcript and clears on completion", async () => {
		const h = setup();
		for (let attempt = 1; attempt <= 17; attempt++) {
			await h.event({
				type: "summarization_retry_scheduled",
				attempt,
				maxAttempts: 20,
				delayMs: 2000,
				errorMessage: providerEnvelope,
			});
			expect(h.chat.render(100).filter((line) => line.trim())).toHaveLength(0);
			expect(h.status.children).toHaveLength(1);
		}
		expect(h.render()).toContain("17/20");
		expect(h.render()).not.toContain('"api_error"');
		await h.event({ type: "summarization_retry_finished" });
		expect(h.status.children).toHaveLength(0);
	});

	it("coalesces repeated plain provider envelopes without hiding unrelated errors", () => {
		const h = setup();
		for (let i = 0; i < 17; i++) h.mode.showError(providerEnvelope);
		expect(h.chat.children).toHaveLength(1);
		expect(h.render()).not.toContain('"api_error"');
		h.mode.showError("Tool failed: fixture permission denied");
		h.mode.showError("Authentication failed: invalid API key");
		h.mode.showError("Usage quota exhausted");
		expect(h.render()).toContain("fixture permission denied");
		expect(h.render()).toContain("invalid API key");
		expect(h.render()).toContain("Usage quota exhausted");
		h.expand();
		expect(h.render()).toContain("api_error");
	});

	it("does not paint a raw message_end error before auto_retry_start, preserving partial text", async () => {
		const h = setup();
		const message = assistantFailure();
		message.content = [{ type: "text", text: "Preserved partial answer" }];
		const stored = structuredClone(message);
		await h.event({ type: "message_start", message });
		await h.event({ type: "message_end", message });
		expect(h.render()).not.toContain('"api_error"');
		expect(h.render()).toContain("Preserved partial answer");
		await h.event({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 20,
			delayMs: 2000,
			errorMessage: providerEnvelope,
		});
		expect(h.render()).not.toContain('"api_error"');
		expect(message).toEqual(stored);
		h.expand();
		expect(h.render()).toContain("api_error");
	});

	it("cancels a retry without appending a final failure", async () => {
		const h = setup();
		await h.event({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 20,
			delayMs: 2000,
			errorMessage: providerEnvelope,
		});
		await h.event({ type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" });
		expect(h.chat.render(100).filter((line) => line.trim())).toHaveLength(0);
		expect(h.status.children).toHaveLength(0);
	});

	it("recovers seventeen live failures without losing stored diagnostics", async () => {
		const h = setup();
		const messages = Array.from({ length: 17 }, () => assistantFailure());
		for (const [index, message] of messages.entries()) {
			await h.event({ type: "message_start", message });
			await h.event({ type: "message_end", message });
			await h.event({
				type: "auto_retry_start",
				attempt: index + 1,
				maxAttempts: 20,
				delayMs: 2000,
				errorMessage: providerEnvelope,
			});
			expect(h.chat.render(100).filter((line) => line.trim())).toHaveLength(0);
			expect(h.status.children).toHaveLength(1);
		}
		const success = {
			...assistantFailure(),
			stopReason: "stop" as const,
			errorMessage: undefined,
			content: [{ type: "text" as const, text: "Recovered answer" }],
		};
		await h.event({ type: "message_start", message: success });
		await h.event({ type: "message_end", message: success });
		await h.event({ type: "auto_retry_end", success: true, attempt: 17 });
		await h.event({ type: "agent_idle" });
		expect(h.status.children).toHaveLength(0);
		expect(h.render()).toContain("Recovered answer");
		expect(h.chat.render(100).filter((line) => line.trim())).toHaveLength(2);
		expect(messages.every((message) => message.errorMessage === providerEnvelope)).toBe(true);
		h.expand();
		expect(h.render().match(/api_error/g)).toHaveLength(1);
		h.expand(false);
		expect(h.render()).not.toContain("api_error");
	});

	it("leaves exactly one actionable failure after exhaustion and keeps independent turns separate", async () => {
		const h = setup();
		for (let turn = 0; turn < 2; turn++) {
			await h.event({ type: "message_start", message: { role: "user", content: `Turn ${turn}`, timestamp: turn } });
			for (let attempt = 1; attempt <= 17; attempt++) {
				h.mode.showError(providerEnvelope);
				await h.event({
					type: "auto_retry_start",
					attempt,
					maxAttempts: 17,
					delayMs: 1000,
					errorMessage: providerEnvelope,
				});
			}
			await h.event({ type: "auto_retry_end", success: false, attempt: 17, finalError: providerEnvelope });
			await h.event({ type: "agent_idle" });
			expect(h.render().match(/\/model/g)).toHaveLength(turn + 1);
			expect(h.status.children).toHaveLength(0);
			expect(h.render()).not.toContain("api_error");
		}
	});

	it("replays failures with partial content, coalesces each turn, and removes recovered notices", () => {
		const h = setup();
		const replay = Reflect.get(h.mode, "renderSessionItems");
		const failure = assistantFailure();
		failure.content = [{ type: "text", text: "Partial history" }];
		const failures = Array.from({ length: 17 }, () => assistantFailure());
		const items = [
			{ role: "user", content: "First", timestamp: 1 },
			failure,
			...failures,
			{
				...assistantFailure(),
				stopReason: "stop",
				errorMessage: undefined,
				content: [{ type: "text", text: "History recovered" }],
			},
			{ role: "user", content: "Second", timestamp: 2 },
			...failures,
		];
		const stored = structuredClone(items);
		replay.call(h.mode, items);
		expect(h.render()).toContain("Partial history");
		expect(h.render()).toContain("History recovered");
		expect(h.render().match(/\/model/g)).toHaveLength(1);
		expect(h.render()).not.toContain("api_error");
		expect(items).toEqual(stored);
		h.expand();
		expect(h.render().match(/api_error/g)).toHaveLength(2);
		h.expand(false);
		expect(h.render()).not.toContain("api_error");
	});

	it("does not coalesce unrelated tool, authentication, or rate-limit envelopes", () => {
		const h = setup();
		const errors = [
			'{"type":"error","error":{"type":"authentication_error","message":"Invalid API key"}}',
			'{"type":"error","error":{"type":"rate_limit_error","message":"Too many requests (429)"}}',
			'{"type":"error","error":{"type":"api_error","message":"Usage quota exhausted"}}',
			"Tool network error while running fixture",
		];
		for (const error of errors) h.mode.showError(error);
		expect(h.chat.children).toHaveLength(8);
		for (const error of errors) expect(h.render(200)).toContain(error);
	});

	it.each(["manual", "threshold"] as const)(
		"leaves one final %s summary failure after retries finish",
		async (reason) => {
			const h = setup();
			for (let attempt = 1; attempt <= 17; attempt++) {
				await h.event({
					type: "summarization_retry_scheduled",
					attempt,
					maxAttempts: 17,
					delayMs: 1000,
					errorMessage: providerEnvelope,
				});
			}
			await h.event({ type: "summarization_retry_finished" });
			await h.event({
				type: "compaction_end",
				reason,
				result: undefined,
				aborted: false,
				willRetry: false,
				errorMessage: providerEnvelope,
			});
			expect(h.render().match(/\/model/g)).toHaveLength(1);
			expect(h.render()).not.toContain("api_error");
		},
	);

	it.each([50, 100])("keeps retry facts visible in a %i-column editor border", async (width) => {
		const h = setup();
		await h.event({
			type: "auto_retry_start",
			attempt: 17,
			maxAttempts: 20,
			delayMs: 2000,
			errorMessage: providerEnvelope,
		});
		const indicator = h.status.children[0];
		if (!(indicator instanceof RetryStatusIndicator)) throw new TypeError("Expected retry indicator");
		const border = indicator.renderInBorder(width - 8);
		expect(border).toContain("17/20");
		expect(border).toContain("2s");
	});
});
