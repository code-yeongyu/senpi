import { describe, expect, it } from "vitest";
import {
	overrideSdkBoundary,
	resetSdkBoundary,
	type SDKMessage,
} from "../../../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";
import { streamClaudeSdkOauth } from "../../../src/core/extensions/builtin/claude-sdk-oauth/stream.ts";

function message(value: unknown): SDKMessage {
	return value as SDKMessage;
}

const text = "API Error: 400 Claude Code 2.1.241 does not support this model; version 2.1.251 or newer is required.";

describe("regression #1298: Claude SDK version-floor errors", () => {
	it("surfaces assistant text and actionable executable guidance", async () => {
		overrideSdkBoundary({
			query: () => ({
				async *[Symbol.asyncIterator]() {
					yield message({ type: "assistant", error: "unknown", message: { content: [{ type: "text", text }] } });
					yield message({
						type: "result",
						subtype: "success",
						is_error: true,
						api_error_status: 400,
						result: text,
					});
				},
				async interrupt() {},
				close() {},
			}),
		});
		try {
			const result = await streamClaudeSdkOauth(
				{
					id: "claude-test",
					name: "Claude",
					api: "claude-sdk-oauth",
					provider: "claude-sdk-oauth",
					baseUrl: "",
					reasoning: true,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 200_000,
					maxTokens: 8_192,
				},
				{ messages: [] },
			).result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("does not support this model");
			expect(result.errorMessage).toContain("CLAUDE_CODE_EXECUTABLE");
			expect(result.errorMessage).toContain("Claude Code 2.1.251 or newer");
			expect(result.errorMessage).not.toContain("<version>");
			expect(result.errorMessage).not.toBe("unknown");
		} finally {
			resetSdkBoundary();
		}
	});
});
