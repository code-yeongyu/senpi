import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessageEvent, type Model, normalizeContext } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/openai-responses";
import type { PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { describe, expect, it } from "vitest";
import { classifyCredentialFailure } from "../../../src/core/credential-pool/classify.ts";
import { rotationErrorFromEvent } from "../../../src/core/credential-pool/rotation-events.ts";
import { streamWithCredentialRotation } from "../../../src/core/credential-pool/rotation-stream.ts";
import { CredentialSlotRepository } from "../../../src/core/credential-pool/state-store.ts";

// senpi#5003: OpenAI's SIWC errors-and-recovery and models-and-inference section 3 are the contract.
// Exercise the real SDK HTTP/SSE decoder, adapter, diagnostic carrier and pool classifier:
// dropping the code at any boundary must fail even when the prose suggests another action.
const model: Model<"openai-responses"> = {
	id: "synthetic",
	name: "Synthetic",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10000,
	maxTokens: 1000,
	compat: { siwc: true },
};

const cases = [
	["subscription_sharing_usage_limit_exceeded", 429, "quota", "limit", false],
	["subscription_sharing_user_not_eligible", 403, "unknown", "disabled", false],
	["subscription_sharing_usage_unavailable", 503, "provider_unavailable", "retry", true],
	["subscription_sharing_user_unavailable", 503, "provider_unavailable", "retry", true],
	["subscription_sharing_invalid_user", 401, "auth", "auth", false],
	["subscription_sharing_unsupported_capability", 400, "invalid_request", "request", false],
	["subscription_sharing_route_not_supported", 403, "invalid_request", "request", false],
	["chatpass_v2_scope_not_authorized", 403, "invalid_request", "request", false],
	["chatpass_v2_invalid_authorization_context", 403, "invalid_request", "request", false],
] as const;

function sse(events: readonly unknown[]): Response {
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

async function run(response: () => Response, selectedModel = model, maxRetries = 0) {
	let calls = 0;
	const events: AssistantMessageEvent[] = [];
	const source = stream(selectedModel, normalizeContext({ messages: [] }), {
		apiKey: "synthetic-test-token",
		maxRetries,
		fetch: async () => {
			calls++;
			return response();
		},
	});
	for await (const event of source) events.push(event);
	const event = events.at(-1);
	if (event === undefined) throw new Error("Missing terminal event");
	return { message: await source.result(), event, calls };
}

describe("SIWC structured recovery through HTTP and SSE", () => {
	for (const form of ["http", "failed", "error"] as const) {
		it.each(cases)(`${form}: %s`, async (code, status, category, action, retryable) => {
			const error = {
				code,
				type: "invalid_request_error",
				message: "billing token unauthorized model_not_found aborted 503 retry later; resets in 999 hours",
				param: "temperature",
			};
			const result = await run(() =>
				form === "http"
					? Response.json({ error }, { status })
					: sse([
							form === "failed"
								? { type: "response.failed", response: { status: "failed", error } }
								: { ...error, type: "error" },
						]),
			);
			expect(result.message.stopReason).toBe("error");
			expect(result.message.providerDiagnostic).toMatchObject({ code, category, evidence: "structured_code" });
			expect(result.message.providerDiagnostic?.resetsAt).toBeUndefined();
			expect(isRetryableAssistantError(result.message)).toBe(retryable);
			const classified = classifyCredentialFailure(rotationErrorFromEvent(result.event), { failureCount: 20 });
			if (action === "limit") {
				expect(classified).toMatchObject({ kind: "failover", block: { reason: "rate_limit" } });
				if (classified.kind !== "failover" || classified.block.reason !== "rate_limit")
					throw new Error("not limited");
				expect(classified.block.cooldownMs).toBeGreaterThan(0);
				expect(classified.block.cooldownMs).toBeLessThanOrEqual(30 * 60_000);
				expect(result.message.errorMessage).toContain("https://chatgpt.com/settings/usage");
			} else if (action === "disabled" || action === "auth") {
				expect(classified).toEqual({
					kind: "failover",
					block: { reason: action === "auth" ? "auth_error" : "account_disabled" },
				});
			} else {
				expect(classified).toEqual(
					action === "retry" ? { kind: "retry_same", maxAttempts: 2 } : { kind: "fail_request" },
				);
			}
			if (code === "subscription_sharing_unsupported_capability") {
				expect(result.message.errorMessage).toContain("temperature");
			}
		});
	}

	it.each([401, 403, 503])("direct-admission detail body: %s", async (status) => {
		const result = await run(() => Response.json({ detail: "token subscription policy denied" }, { status }));
		expect(result.message.errorMessage).toContain("token subscription policy denied");
		expect(result.message.providerDiagnostic).toMatchObject({ httpStatus: status, evidence: "structured_status" });
		expect(classifyCredentialFailure(rotationErrorFromEvent(result.event))).toEqual(
			status === 401
				? { kind: "failover", block: { reason: "auth_error" } }
				: status === 503
					? { kind: "retry_same", maxAttempts: 2 }
					: { kind: "fail_request" },
		);
		expect(isRetryableAssistantError(result.message)).toBe(status === 503);
	});

	it.each([
		["subscription_sharing_usage_limit_exceeded", 429],
		["subscription_sharing_user_not_eligible", 403],
	] as const)("%s is not replayed by HTTP retries, even with retry guidance", async (code, status) => {
		const result = await run(
			() =>
				Response.json(
					{ error: { code, message: "retry later" } },
					{ status, headers: { "x-should-retry": "true", "retry-after": "0" } },
				),
			model,
			3,
		);
		expect(result.calls).toBe(1);
	});

	it.each(["response.completed", "response.incomplete", "interrupted"])(
		"%s has distinct completion semantics",
		async (type) => {
			const result = await run(() =>
				sse(
					type === "interrupted"
						? []
						: [
								{
									type,
									response: {
										id: "synthetic",
										status: type === "response.completed" ? "completed" : "incomplete",
										incomplete_details: { reason: "max_output_tokens" },
										output: [],
										usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 },
									},
								},
							],
				),
			);
			expect(result.message.stopReason).toBe(type === "response.completed" ? "stop" : "error");
			if (type !== "interrupted") expect(result.message.usage.totalTokens).toBe(13);
			if (type !== "response.completed") {
				expect(result.message.errorMessage).toContain(
					type === "interrupted" ? "terminal response event" : "incomplete",
				);
			}
		},
	);

	it("leaves non-SIWC admission policy unchanged", async () => {
		const result = await run(() => Response.json({ detail: "subscription token denied" }, { status: 403 }), {
			...model,
			compat: {},
		});
		expect(result.message.providerDiagnostic).toBeUndefined();
	});

	it.each([true, false])("finished tools without response.completed, siwc=%s", async (siwc) => {
		const item = { type: "function_call", id: "fc_1", call_id: "call_1", name: "synthetic", arguments: "{}" };
		const result = await run(
			() =>
				sse([
					{ type: "response.output_item.added", output_index: 0, item },
					{ type: "response.output_item.done", output_index: 0, item },
				]),
			{ ...model, compat: { siwc } },
		);
		expect(result.message.stopReason).toBe("error");
		expect(result.message.errorMessage).toContain(siwc ? "terminal response event" : "without a stop reason");
	});

	it.each([
		["subscription_sharing_usage_unavailable", 503, ["alpha", "alpha"], undefined],
		["subscription_sharing_user_unavailable", 503, ["alpha", "alpha"], undefined],
		["subscription_sharing_user_not_eligible", 403, ["alpha", "bravo"], "account_disabled"],
		["subscription_sharing_route_not_supported", 403, ["alpha"], undefined],
	] as const)("%s persists the intended account health", async (code, status, expectedAttempts, blockReason) => {
		const dir = mkdtempSync(join(tmpdir(), "siwc-errors-"));
		try {
			const repository = new CredentialSlotRepository(join(dir, "pool.json"));
			const credential: PooledCredential = {
				type: "oauth",
				access: "managed",
				refresh: "managed",
				expires: Date.UTC(2030, 0, 1),
				accounts: [
					{ name: "alpha", access: "alpha-access", refresh: "alpha-refresh", source: "login" },
					{ name: "bravo", access: "bravo-access", refresh: "bravo-refresh", source: "login" },
				],
			};
			const attempts: string[] = [];
			const events: AssistantMessageEvent[] = [];
			for await (const event of streamWithCredentialRotation({
				sources: {
					providerId: model.provider,
					credential,
					env: () => undefined,
					repository,
					policy: { affinity: false },
					now: () => Date.UTC(2026, 9, 30),
				},
				runAttempt: async function* (slot) {
					attempts.push(slot.name);
					const result = await run(() =>
						slot.name === "alpha"
							? Response.json({ error: { code, message: "denied" } }, { status })
							: sse([{ type: "response.completed", response: { id: "ok", status: "completed", output: [] } }]),
					);
					yield result.event;
				},
			}))
				events.push(event);
			expect(attempts).toEqual(expectedAttempts);
			const health = await repository.listSlots(model.provider, "stored");
			expect(health.alpha?.blockReason).toBe(blockReason);
			expect(health.alpha?.blockedUntil).toBeUndefined();
			expect(events.at(-1)?.type).toBe(blockReason === "account_disabled" ? "done" : "error");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
