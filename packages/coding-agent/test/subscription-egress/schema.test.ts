import { describe, expect, it } from "vitest";
import { providerCallCommandSchema, providerCallOutputSchema } from "../../src/subscription-egress/index.ts";
import { cancel, request } from "./fixtures.ts";

describe("SUBEGRESS v1 wire contract (#4998)", () => {
	it("roundtrips starts and cancellation without host capabilities", () => {
		for (const value of [request, cancel()]) {
			expect(providerCallCommandSchema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
		}
	});

	it.each(["env", "apiKey", "headers", "cwd", "baseUrl", "sessionId", "account", "signal"])(
		"rejects remote %s control fields instead of forwarding them",
		(key) => {
			expect(providerCallCommandSchema.safeParse({ ...request, [key]: "secret" }).success).toBe(false);
			expect(
				providerCallCommandSchema.safeParse({
					...request,
					options: { [key]: "secret" },
				}).success,
			).toBe(false);
		},
	);

	it.each([
		{ version: 2 },
		{ epoch: -1 },
		{ epoch: 0.5 },
		{ epoch: Number.MAX_SAFE_INTEGER + 1 },
		{ callId: "" },
		{ provider: "anthropic" },
		{ model: { id: "injected", baseUrl: "https://invalid" } },
		{ options: { maxTokens: 0 } },
		{ options: { reasoning: "unknown" } },
		{ context: { messages: [{ role: "user", content: 42, timestamp: 1 }] } },
		{ context: { messages: [], env: { TOKEN: "not-allowed" } } },
		{
			context: {
				messages: [{ role: "user", content: [{ type: "text", text: "hello", callback: () => {} }], timestamp: 1 }],
			},
		},
		{
			context: {
				messages: [{ role: "user", content: [{ type: "text", text: "hello", extra: Infinity }], timestamp: 1 }],
			},
		},
	])("rejects malformed requests %j", (patch) => {
		expect(providerCallCommandSchema.safeParse({ ...request, ...patch }).success).toBe(false);
	});

	it("requires a sequenced subscription terminal and a closed error enum", () => {
		const identity = { version: 1, threadId: "thread-a", epoch: 1, callId: "call-a", seq: 0 };
		const value = {
			...identity,
			type: "provider.call.error",
			code: "unavailable",
			retryable: false,
			billing: "subscription",
		};
		expect(providerCallOutputSchema.parse(value)).toEqual(value);
		for (const patch of [{ seq: -1 }, { billing: "metered" }, { code: "raw_sdk_error" }, { stderr: "secret" }]) {
			expect(providerCallOutputSchema.safeParse({ ...value, ...patch }).success).toBe(false);
		}
	});
});
