import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamCompletions } from "../src/api/openai-completions.ts";
import { stream as streamResponses } from "../src/api/openai-responses.ts";
import { getModel } from "../src/compat.ts";
import type { AssistantMessage, AssistantMessageEventStream, Context } from "../src/types.ts";
import { classifyErrorMessage } from "../src/utils/retry.ts";

import { normalizeContext } from "../src/utils/transcript.ts";

const context: Context = { messages: [{ role: "user", content: "Reply with OK.", timestamp: 0 }] };
const REQUEST_ID = "C6FD:A429:AEB5500:CC3FDF2:6ABA4D81";

function replying(response: () => Response): typeof fetch {
	return (() => Promise.resolve(response())) as unknown as typeof fetch;
}

async function failure(events: AssistantMessageEventStream): Promise<AssistantMessage> {
	for await (const event of events) {
		if (event.type === "error") return event.error;
		if (event.type === "done") throw new Error("expected the request to fail");
	}
	throw new Error("stream ended without a terminal event");
}

describe("GitHub Copilot failures are explained, not bare statuses (#2297)", () => {
	it("names an empty-body 403 on the Responses API and records its status", async () => {
		const error = await failure(
			streamResponses(getModel("github-copilot", "gpt-5.6-sol"), normalizeContext(context), {
				apiKey: "tid=test",
				fetch: replying(() => new Response("", { status: 403, headers: { "x-github-request-id": REQUEST_ID } })),
			}),
		);

		expect(error.providerDiagnostic?.httpStatus).toBe(403);
		expect(error.errorMessage).toContain("GitHub Copilot refused the request (HTTP 403 with an empty body)");
		expect(error.errorMessage).toContain(`GitHub request id: ${REQUEST_ID}`);
	});

	it("names a 403 on the Anthropic Messages API", async () => {
		const error = await failure(
			streamAnthropic(getModel("github-copilot", "claude-opus-5"), normalizeContext(context), {
				apiKey: "tid=test",
				fetch: replying(() => new Response("", { status: 403, headers: { "x-github-request-id": REQUEST_ID } })),
			}),
		);

		expect(error.providerDiagnostic?.httpStatus).toBe(403);
		expect(error.errorMessage).toContain("GitHub Copilot refused the request (HTTP 403");
		expect(error.errorMessage).toContain(`GitHub request id: ${REQUEST_ID}`);
	});

	it("calls a 402 and a 429 quota_exceeded a quota, not an access problem", async () => {
		const paymentRequired = await failure(
			streamCompletions(getModel("github-copilot", "kimi-k3"), normalizeContext(context), {
				apiKey: "tid=test",
				fetch: replying(() =>
					Response.json(
						{ error: { code: "additional_spend_limit_reached", message: "limit reached" } },
						{ status: 402, headers: { "x-github-request-id": REQUEST_ID } },
					),
				),
			}),
		);
		const tooMany = await failure(
			streamCompletions(getModel("github-copilot", "kimi-k3"), normalizeContext(context), {
				apiKey: "tid=test",
				fetch: replying(
					() =>
						new Response("quota exceeded", {
							status: 429,
							headers: { "x-ratelimit-exceeded": "quota_exceeded", "content-type": "text/plain" },
						}),
				),
			}),
		);

		expect(paymentRequired.errorMessage).toContain("GitHub Copilot quota exceeded (HTTP 402)");
		expect(paymentRequired.errorMessage).toContain(`GitHub request id: ${REQUEST_ID}`);
		expect(tooMany.errorMessage).toContain("GitHub Copilot quota exceeded (HTTP 429)");
		expect(classifyErrorMessage(paymentRequired.errorMessage ?? "")).toBe("non-retryable");
	});

	it("never lets a request id that contains 429 or 500 pose as an HTTP status", () => {
		const withId = `403 status code (no body)\nGitHub Copilot refused the request. GitHub request id: ${REQUEST_ID}.`;
		const withoutId = "403 status code (no body)\nGitHub Copilot refused the request.";

		expect(classifyErrorMessage(withId)).toBe(classifyErrorMessage(withoutId));
		expect(classifyErrorMessage(withId)).toBe("unknown");
	});
});
