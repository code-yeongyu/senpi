import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { abortedErrorLabel, abortedMessageForRendering } from "../src/modes/interactive/aborted-error-label.ts";

describe("abortedErrorLabel", () => {
	it("uses the persisted label when replaying an aborted message", () => {
		expect(abortedErrorLabel("Aborted after 2 retry attempts", 0, undefined)).toBe(
			"Provider retry failed after 2 attempts",
		);
	});

	it("preserves explicit user abort when there were no retries", () => {
		expect(abortedErrorLabel(undefined, 0, "user")).toBe("Operation aborted");
	});

	it("formats a singular retry attempt label", () => {
		expect(abortedErrorLabel(undefined, 1, undefined)).toBe("Provider retry failed after 1 attempt");
	});

	it("formats a plural retry attempts label", () => {
		expect(abortedErrorLabel(undefined, 2, undefined)).toBe("Provider retry failed after 2 attempts");
	});

	it("distinguishes explicit user and system aborts", () => {
		expect(abortedErrorLabel(undefined, 2, "user")).toBe("Operation aborted");
		expect(abortedErrorLabel(undefined, 2, "system")).toBe("System operation aborted");
	});

	it("preserves persisted explicit abort labels when replaying a transcript", () => {
		expect(abortedErrorLabel("Operation aborted", 0, undefined)).toBe("Operation aborted");
		expect(abortedErrorLabel("System operation aborted", 0, undefined)).toBe("System operation aborted");
	});

	it("round-trips labels the live path persists without re-prefixing on replay", () => {
		// A replay has no live provenance; the persisted label must render verbatim.
		expect(abortedErrorLabel("Provider retry failed after 2 attempts", 0, undefined)).toBe(
			"Provider retry failed after 2 attempts",
		);
		expect(abortedErrorLabel("Provider request failed: 429 usage limit reached", 0, undefined)).toBe(
			"Provider request failed: 429 usage limit reached",
		);
		expect(abortedErrorLabel("Provider request failed", 0, undefined)).toBe("Provider request failed");
	});

	it("renders a provider label without mutating the message", () => {
		const message = {
			role: "assistant",
			content: [],
			api: "openai-responses",
			provider: "openai",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "aborted",
			errorMessage:
				"Provider stream start timed out after 90000ms (raise streamStartTimeoutMs — retry.provider.streamStartTimeoutMs in senpi settings; 0 disables)",
			timestamp: 0,
		} satisfies AssistantMessage;
		const rendered = abortedMessageForRendering(message, 1, "provider");
		expect(rendered.errorMessage).toContain("Provider stream start timed out");
		expect(message.errorMessage).toBe(
			"Provider stream start timed out after 90000ms (raise streamStartTimeoutMs — retry.provider.streamStartTimeoutMs in senpi settings; 0 disables)",
		);
	});

	it("includes a specific provider error without repeating generic abort wording", () => {
		expect(abortedErrorLabel("429 usage limit reached", 0, undefined)).toBe(
			"Provider request failed: 429 usage limit reached",
		);
		expect(abortedErrorLabel("Request was aborted", 0, undefined)).toBe("Provider request failed");
	});
});
