import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { RetryWait } from "../../../src/core/retry-wait.ts";
import { sessionRuntimeView } from "../../../src/modes/rpc/session-status-source.ts";
import { createHarness, type Harness } from "../harness.ts";

/**
 * Regression for senpi#7025: a session sleeping in an auto-retry backoff reported plain `running`, so a
 * supervisor (same host, or another device through a forwarding service) could not tell a rate-limit wait from
 * work. The runtime view a `session_status` is derived from now carries the wait while the engine sleeps, and
 * nothing once the retried request starts or the retry ends.
 */
describe("issue #7025: the status runtime view carries a retry wait only while the engine sleeps", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("reports a rate_limit wait with its until during each backoff, and none after the turn", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 10 } },
		});
		harnesses.push(harness);
		const rateLimited = () =>
			fauxAssistantMessage("", { stopReason: "error" as const, errorMessage: "429 rate_limit_exceeded: slow down" });
		harness.setResponses([rateLimited(), rateLimited(), fauxAssistantMessage("recovered")]);

		const seen: Array<{ readonly at: number; readonly delayMs: number; readonly waiting: RetryWait | undefined }> =
			[];
		let startedWhileWaiting = false;
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start")
				seen.push({ at: Date.now(), delayMs: event.delayMs, waiting: sessionRuntimeView(harness.session).waiting });
			if (event.type === "agent_start" && sessionRuntimeView(harness.session).waiting !== undefined)
				startedWhileWaiting = true;
		});

		await harness.session.prompt("test");

		expect(seen).toHaveLength(2);
		for (const [index, { at, delayMs, waiting }] of seen.entries()) {
			expect(waiting).toMatchObject({ kind: "rate_limit", attempt: index + 1, maxAttempts: 3, delayMs });
			expect(waiting?.error).toContain("429");
			const until = Date.parse(waiting?.until ?? "");
			expect(until).toBeGreaterThanOrEqual(at - 1000 + delayMs);
			expect(until).toBeLessThanOrEqual(at + delayMs);
		}
		expect(startedWhileWaiting).toBe(false);
		expect(sessionRuntimeView(harness.session).waiting).toBeUndefined();
	});

	it("reports a plain retry wait for a transient non-rate-limit error", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 10 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error" as const, errorMessage: "503 service unavailable" }),
			fauxAssistantMessage("recovered"),
		]);
		const kinds: Array<string | undefined> = [];
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") kinds.push(sessionRuntimeView(harness.session).waiting?.kind);
		});

		await harness.session.prompt("test");

		expect(kinds).toEqual(["retry"]);
		expect(sessionRuntimeView(harness.session).waiting).toBeUndefined();
	});
});
