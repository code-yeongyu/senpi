import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import type { SdkQueryHandle } from "../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";
import { evaluateAbortOutcome } from "../src/core/extensions/builtin/claude-sdk-oauth/session-reattach.ts";
import {
	ClaudeSdkOauthSessionRegistry,
	overrideSessionRegistryBoundary,
	resetSessionRegistryBoundary,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-registry.ts";
import { submitSessionTurn } from "../src/core/extensions/builtin/claude-sdk-oauth/session-registry-pump.ts";

describe("claude-sdk-oauth abort continuity", () => {
	it("keeps the live session when the interrupt receipt proves nothing is still queued", () => {
		expect(evaluateAbortOutcome({ still_queued: [] })).toBe("keep");
	});

	it("reattaches instead of continuing when queued work survived the interrupt", () => {
		expect(evaluateAbortOutcome({ still_queued: ["uuid-1"] })).toBe("reattach");
	});

	it("reattaches when the CLI returns a legacy receipt with no queue information", () => {
		expect(evaluateAbortOutcome(undefined)).toBe("reattach");
		expect(evaluateAbortOutcome({})).toBe("reattach");
	});

	it("never resolves an abort to a flattened re-send", () => {
		const outcomes = [
			evaluateAbortOutcome({ still_queued: [] }),
			evaluateAbortOutcome({ still_queued: ["a"] }),
			evaluateAbortOutcome(undefined),
			evaluateAbortOutcome("garbage"),
		];

		expect(outcomes.every((outcome) => outcome === "keep" || outcome === "reattach")).toBe(true);
	});

	it("resolves an aborted turn when the CLI never delivers a terminal result", async () => {
		const query = {
			async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
				await new Promise(() => {});
			},
			async interrupt() {
				return undefined;
			},
			close() {},
		} satisfies SdkQueryHandle;
		overrideSessionRegistryBoundary({ queryFactory: () => query });
		const registry = new ClaudeSdkOauthSessionRegistry();
		const entry = registry.getOrCreate({
			senpiSessionId: "abort-grace",
			accountName: "primary",
			modelId: "claude-opus-4-5",
			toolsetHash: "tools",
			systemPromptHash: "prompt",
			options: {} as never,
		});
		const abort = new AbortController();
		let fireGrace!: () => void;
		const turn = submitSessionTurn(registry, entry, {
			message: { role: "user", content: "hi" } as never,
			signal: abort.signal,
			scheduleAbort: (callback) => {
				fireGrace = callback;
				return () => {};
			},
		});
		abort.abort();
		await Promise.resolve();
		fireGrace();

		// The boundary override must be restored even when an assertion fails,
		// or it leaks into the next test.
		try {
			const result = await turn;
			expect(result.aborted).toBe(true);
		} finally {
			resetSessionRegistryBoundary();
		}
	});
});
