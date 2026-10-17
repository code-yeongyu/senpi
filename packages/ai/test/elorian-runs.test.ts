import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { ELORIAN_MODELS } from "../src/providers/elorian.models.ts";
import { elorianProvider } from "../src/providers/elorian.ts";
import type { DeferredHandle, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-completions"> = {
	...ELORIAN_MODELS["elorian-1-agent"],
	baseUrl: "https://elorian.test/v1",
};
const handle: DeferredHandle = {
	id: "run/test",
	provider: "elorian",
	modelId: model.id,
	api: model.api,
};
const context = normalizeContext({ messages: [{ role: "user", content: "Make a chart.", timestamp: 1 }] });
const completion = {
	id: "completion-1",
	model: "elorian-snapshot",
	choices: [{ message: { role: "assistant", content: "Chart ready." }, finish_reason: "stop" }],
	usage: {
		prompt_tokens: 20,
		completion_tokens: 5,
		prompt_tokens_details: { cached_tokens: 10 },
		elorian: { images: 1 },
	},
	elorian: { files: [{ name: "chart.png", url: "/v1/runs/run-1/artifacts/chart.png" }] },
};

// The actual provider must turn queued runs into durable handles, then reuse the
// normal completion parser for final text, tool calls, usage and native artifacts.
describe("Elorian background runs", () => {
	it.each(["deferred", "extraBody", "modelSamplingParams", "requestSamplingParams", "payload"] as const)(
		"starts a run through %s without sending an SSE request",
		async (source) => {
			let sent: unknown;
			let responseId: string | undefined;
			const selectedModel =
				source === "modelSamplingParams"
					? { ...model, samplingParams: { background: true, mode: "max" } }
					: source === "extraBody"
						? model
						: { ...model, samplingParams: { background: false } };
			const result = await elorianProvider()
				.streamSimple(selectedModel, context, {
					apiKey: "elorian-test",
					deferred: source === "deferred",
					extraBody: source === "extraBody" ? { background: true } : undefined,
					samplingParams: source === "requestSamplingParams" ? { background: true } : undefined,
					onPayload: (payload) => {
						if (source !== "payload") return;
						if (typeof payload !== "object" || payload === null) throw new Error("Expected a payload object");
						return { ...payload, background: true };
					},
					maxRetries: 0,
					onResponse: (response) => {
						responseId = response.headers["x-request-id"];
					},
					fetch: async (input, init) => {
						const request = new Request(input, init);
						expect(request.url).toBe("https://elorian.test/v1/chat/completions");
						expect(request.headers.get("authorization")).toBe("Bearer elorian-test");
						sent = await request.json();
						return Response.json({ id: "run-1", status: "queued" }, { headers: { "x-request-id": "request-1" } });
					},
				})
				.result();
			expect(sent).toMatchObject({ model: model.id, stream: false, background: true });
			expect(responseId).toBe("request-1");
			expect(result.stopReason).toBe("deferred");
			expect(result.deferred).toMatchObject({ ...handle, id: "run-1" });
		},
	);

	it.each(["requestSamplingParams", "modelSamplingParams", "payload"] as const)(
		"honours %s disabling background under the normal payload precedence",
		async (source) => {
			let sent: unknown;
			const result = await elorianProvider()
				.streamSimple({ ...model, samplingParams: { background: source !== "modelSamplingParams" } }, context, {
					apiKey: "elorian-test",
					extraBody: { background: true },
					samplingParams: source === "requestSamplingParams" ? { background: false } : undefined,
					onPayload: (payload) => {
						if (source !== "payload") return;
						if (typeof payload !== "object" || payload === null) throw new Error("Expected a payload object");
						return { ...payload, background: false };
					},
					maxRetries: 0,
					fetch: async (input, init) => {
						sent = await new Request(input, init).json();
						return new Response(
							`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Ready." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
							{ headers: { "content-type": "text/event-stream" } },
						);
					},
				})
				.result();
			expect(sent).toMatchObject({ stream: true, background: false });
			expect(result.stopReason).toBe("stop");
			expect(result.content).toContainEqual({ type: "text", text: "Ready." });
		},
	);

	// Account identity must stay stable across the public HTTP lifecycle, including
	// model-header overrides, request-header overrides, and explicit suppression.
	it.each([
		{ headers: undefined, expected: "Bearer model-account" },
		{ headers: { authorization: "Bearer request-account" }, expected: "Bearer request-account" },
		{ headers: { authorization: null }, expected: null },
	])("preserves effective authorization $expected when fetching and cancelling", async ({ headers, expected }) => {
		const selectedModel = { ...model, headers: { authorization: "Bearer model-account" } };
		const paths: string[] = [];
		const options = {
			apiKey: "options-account",
			headers,
			fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
				const request = new Request(input, init);
				const path = new URL(request.url).pathname;
				paths.push(path);
				expect(request.headers.get("authorization")).toBe(expected);
				if (path.endsWith("/cancel")) return new Response(null, { status: 204 });
				return Response.json({ id: "run-1", status: "queued" });
			},
		};
		const provider = elorianProvider();
		const started = await provider.streamSimple(selectedModel, context, { ...options, deferred: true }).result();
		expect(started.stopReason).toBe("deferred");
		if (!started.deferred) throw new Error("Expected a queued run handle");
		const fetched = await provider.fetchDeferred?.(selectedModel, started.deferred, options).result();
		expect(fetched?.stopReason).toBe("deferred");
		await provider.cancelDeferred?.(selectedModel, started.deferred, options);
		expect(paths).toEqual(["/v1/chat/completions", "/v1/runs/run-1", "/v1/runs/run-1/cancel"]);
	});

	it("keeps an unfinished run deferred after one authenticated status read", async () => {
		const provider = elorianProvider();
		const result = await provider
			.fetchDeferred?.(model, handle, {
				apiKey: "elorian-test",
				fetch: async (input, init) => {
					const request = new Request(input, init);
					expect(request.url).toBe("https://elorian.test/v1/runs/run%2Ftest");
					expect(request.headers.get("authorization")).toBe("Bearer elorian-test");
					return Response.json({ id: handle.id, status: "in_progress" });
				},
			})
			.result();
		expect(result?.stopReason).toBe("deferred");
		expect(result?.deferred).toEqual(handle);
	});

	it("restores completed text, cached usage, provenance and artifacts", async () => {
		const result = await elorianProvider()
			.fetchDeferred?.({ ...model, samplingParams: { background: true } }, handle, {
				apiKey: "elorian-test",
				fetch: async () => Response.json({ id: handle.id, status: "completed", completion }),
			})
			.result();
		expect(result?.stopReason).toBe("stop");
		expect(result?.content).toContainEqual({ type: "text", text: "Chart ready." });
		expect(result?.usage).toMatchObject({ input: 10, cacheRead: 10, output: 5 });
		expect(result?.content).toContainEqual({
			type: "providerNative",
			subtype: "elorian",
			raw: completion.elorian,
		});
		expect(result?.content).toContainEqual({
			type: "providerNative",
			subtype: "usage.elorian",
			raw: completion.usage.elorian,
		});
	});

	it.each(["native", "xml"])("reconstructs %s client calls after persisting a queued run", async (format) => {
		// Given: a run with a local tool, persisted and reopened with a fresh provider.
		const started = await elorianProvider()
			.streamSimple(
				model,
				normalizeContext({
					messages: context.messages,
					tools: [
						{ name: "read", description: "Read a local file", parameters: Type.Object({ path: Type.String() }) },
					],
				}),
				{
					apiKey: "elorian-test",
					deferred: true,
					fetch: async () => Response.json({ id: "run-1", status: "queued" }),
				},
			)
			.result();
		expect(started.stopReason).toBe("deferred");
		if (!started.deferred) throw new Error("Expected a queued handle");
		const pending = await elorianProvider()
			.fetchDeferred?.(model, JSON.parse(JSON.stringify(started.deferred)), {
				apiKey: "elorian-test",
				fetch: async () => Response.json({ status: "in_progress" }),
			})
			.result();
		expect(pending?.stopReason).toBe("deferred");
		if (!pending?.deferred) throw new Error("Expected the pending handle");
		// When: the persisted handle completes with a deployed XML handoff or a native call.
		const result = await elorianProvider()
			.fetchDeferred?.(model, JSON.parse(JSON.stringify(pending.deferred)), {
				apiKey: "elorian-test",
				fetch: async () =>
					Response.json({
						status: "completed",
						completion: {
							...completion,
							choices: [
								{
									message: {
										role: "assistant",
										content: format === "xml" ? "<read><path>x</path></read>" : null,
										tool_calls:
											format === "native"
												? [
														{
															id: "call-1",
															type: "function",
															function: { name: "read", arguments: '{"path":"x"}' },
														},
													]
												: undefined,
									},
									finish_reason: format === "xml" ? "stop" : "tool_calls",
								},
							],
						},
					}),
			})
			.result();
		// Then: both forms deliver an executable canonical call after the durable round trip.
		expect(result?.stopReason).toBe("toolUse");
		expect(result?.content).toContainEqual({
			type: "toolCall",
			id: format === "native" ? "call-1" : expect.any(String),
			name: "read",
			arguments: { path: "x" },
		});
	});

	it.each(["failed", "cancelled", "unknown"])("reports a %s run as a terminal error", async (status) => {
		const result = await elorianProvider()
			.fetchDeferred?.(model, handle, {
				apiKey: "elorian-test",
				fetch: async () => Response.json({ status }),
			})
			.result();
		expect(result?.stopReason).toBe("error");
		expect(result?.errorMessage).toContain(status);
	});

	it("cancels the correct run with the request credential", async () => {
		let request: Request | undefined;
		await elorianProvider().cancelDeferred?.(model, handle, {
			apiKey: "elorian-test",
			fetch: async (input, init) => {
				request = new Request(input, init);
				return new Response(null, { status: 204 });
			},
		});
		expect(request?.url).toBe("https://elorian.test/v1/runs/run%2Ftest/cancel");
		expect(request?.method).toBe("POST");
		expect(request?.headers.get("authorization")).toBe("Bearer elorian-test");
	});

	it("does not request a handle owned by another model", async () => {
		const result = await elorianProvider()
			.fetchDeferred?.(
				model,
				{ ...handle, modelId: "another-model" },
				{
					fetch: async () => {
						throw new Error("must not send a request");
					},
				},
			)
			.result();
		expect(result?.stopReason).toBe("error");
		expect(result?.errorMessage).toContain("different model");
	});

	it("preserves caller cancellation during run retrieval", async () => {
		const controller = new AbortController();
		const result = elorianProvider().fetchDeferred?.(model, handle, {
			apiKey: "elorian-test",
			signal: controller.signal,
			fetch: async (_input, init) => {
				controller.abort(new Error("cancelled by caller"));
				init?.signal?.throwIfAborted();
				throw new Error("expected cancellation");
			},
		});
		expect((await result?.result())?.stopReason).toBe("aborted");
	});
});
