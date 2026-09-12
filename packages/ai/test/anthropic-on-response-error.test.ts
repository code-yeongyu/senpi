import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { getModel } from "../src/compat.ts";
import { streamAnthropic } from "../src/providers/anthropic.ts";
import type { Context } from "../src/types.ts";

/**
 * The Anthropic SDK turns HTTP failures into a rejected `APIError`, so a 400
 * never produced a Response object and `onResponse` was never called. The
 * native tool-search adapter (and every `after_provider_response` extension)
 * needs the status anyway: its permanent 400 fallback is keyed on it. Deliver
 * the numeric status on the rejection path once, after internal retries, and
 * never fabricate one for errors that carry no status.
 */

function createRejectingAnthropicClient(error: unknown): Anthropic {
	return {
		beta: {
			messages: {
				create: () => ({
					asResponse: async () => {
						throw error;
					},
				}),
			},
		},
	} as unknown as Anthropic;
}

function anthropicApiError(status: number, message: string): Error & { status: number } {
	const error = new Error(
		`${status} {"type":"error","error":{"type":"invalid_request_error","message":"${message}"}}`,
	) as Error & {
		status: number;
	};
	error.status = status;
	return error;
}

function streamWith(
	error: unknown,
	onResponse: (response: { status: number; headers: unknown }, model: unknown) => void,
) {
	const context: Context = {
		messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
		tools: [],
	};
	return streamAnthropic(getModel("anthropic", "claude-haiku-4-5"), context, {
		apiKey: "fake-key",
		client: createRejectingAnthropicClient(error),
		onResponse: onResponse as never,
	});
}

describe("Anthropic onResponse on rejected requests", () => {
	it("reports the HTTP status when the SDK rejects with an APIError", async () => {
		const onResponse = vi.fn();
		const s = streamWith(
			anthropicApiError(400, "Tool reference 'mcp__925c__memory' not found in available tools"),
			onResponse,
		);

		const message = await s.result();
		expect(message.stopReason).toBe("error");
		expect(String(message.errorMessage)).toContain("400");
		expect(onResponse).toHaveBeenCalledTimes(1);
		expect(onResponse).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }), expect.anything());
	});

	it("reports other numeric statuses too", async () => {
		const onResponse = vi.fn();
		const s = streamWith(anthropicApiError(500, "internal error"), onResponse);

		const message = await s.result();
		expect(message.stopReason).toBe("error");
		expect(onResponse).toHaveBeenCalledTimes(1);
		expect(onResponse).toHaveBeenCalledWith(expect.objectContaining({ status: 500 }), expect.anything());
	});

	it("does not report a fabricated status for errors that carry none", async () => {
		const onResponse = vi.fn();
		const s = streamWith(new Error("socket hangup"), onResponse);

		const message = await s.result();
		expect(message.stopReason).toBe("error");
		expect(String(message.errorMessage)).toContain("socket hangup");
		expect(onResponse).not.toHaveBeenCalled();
	});
});
