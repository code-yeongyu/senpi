import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGoogleCcaRequest } from "../src/api/google-gemini-cli.ts";
import { googleAntigravityProvider, googleGeminiCliProvider } from "../src/providers/google-gemini-cli.ts";
import type { Model } from "../src/types.ts";

const sse = (payload: unknown) =>
	new Response(`data: ${JSON.stringify(payload)}\n\n`, {
		status: 200,
		headers: { "Content-Type": "text/event-stream" },
	});

const context = { messages: [{ role: "user" as const, content: "hello", timestamp: 0 }] };

describe("Google Cloud Code Assist runtime", () => {
	afterEach(() => vi.unstubAllGlobals());

	it.each([
		[googleGeminiCliProvider, "google-gemini-cli", "Client-Metadata"],
		[googleAntigravityProvider, "google-antigravity", "User-Agent"],
	] as const)("uses the CCA SSE contract for %s", async (factory, providerId, providerHeader) => {
		let requestUrl = "";
		let requestInit: RequestInit | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				requestUrl = String(input);
				requestInit = init;
				return sse({
					response: {
						candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
					},
				});
			}),
		);
		const provider = factory();
		const model = provider.getModels()[0]!;
		const result = await provider
			.stream(model, context, {
				apiKey: JSON.stringify({ token: "access-secret", projectId: "project-123" }),
			})
			.result();
		expect(result.stopReason).toBe("stop");
		expect(requestUrl).toContain("/v1internal:streamGenerateContent?alt=sse");
		const headers = new Headers(requestInit?.headers);
		expect(headers.get("Authorization")).toBe("Bearer access-secret");
		expect(headers.has(providerHeader)).toBe(true);
		expect(JSON.parse(String(requestInit?.body))).toMatchObject({
			project: "project-123",
			model: model.id,
			request: { contents: expect.any(Array) },
		});
		expect(model.provider).toBe(providerId);
	});

	it("emits complete lifecycle events for thinking, text, and tool calls", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				sse({
					response: {
						candidates: [
							{
								content: {
									role: "model",
									parts: [
										{ text: "consider", thought: true },
										{ text: "answer" },
										{
											functionCall: {
												id: "call-1",
												name: "lookup_weather",
												args: { city: "Seoul" },
											},
										},
									],
								},
								finishReason: "STOP",
							},
						],
					},
				}),
			),
		);
		const provider = googleGeminiCliProvider();
		const eventTypes: string[] = [];
		let thinkingEndContent: string | undefined;
		let textEndContent: string | undefined;
		let toolArgumentsDelta: string | undefined;
		for await (const event of provider.stream(provider.getModels()[0]!, context, {
			apiKey: JSON.stringify({ token: "access-secret", projectId: "project-123" }),
		})) {
			eventTypes.push(event.type);
			if (event.type === "thinking_end") thinkingEndContent = event.content;
			if (event.type === "text_end") textEndContent = event.content;
			if (event.type === "toolcall_delta") toolArgumentsDelta = event.delta;
		}

		expect(eventTypes).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_end",
			"text_start",
			"text_delta",
			"text_end",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
			"done",
		]);
		expect(thinkingEndContent).toBe("consider");
		expect(textEndContent).toBe("answer");
		expect(toolArgumentsDelta).toBe('{"city":"Seoul"}');
	});

	it("rejects credentials without a nonempty project id before issuing a request", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const provider = googleGeminiCliProvider();
		const result = await provider
			.stream(provider.getModels()[0]!, context, {
				apiKey: JSON.stringify({ token: "access-secret" }),
			})
			.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/projectId/i);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([
		"gemini-3-flash",
		"claude-sonnet-4-6",
	])("prepends the Antigravity instruction for %s requests", (modelId) => {
		const model: Model<"google-gemini-cli"> = {
			id: modelId,
			name: modelId,
			api: "google-gemini-cli",
			provider: "google-antigravity",
			baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 64_000,
		};
		const body = buildGoogleCcaRequest(
			model,
			{ ...context, systemPrompt: "Follow the repository instructions." },
			"project-123",
		);
		const parts = body.request.systemInstruction?.parts;
		expect(parts).toHaveLength(2);
		expect(parts?.[0]?.text).toMatch(/Antigravity.*agentic AI coding assistant/);
		expect(parts?.[1]?.text).toBe("Follow the repository instructions.");
		expect(body.request.preambleConfig).toEqual({ mode: "SYSTEM_INSTRUCTION_MODE_REPLACE" });
	});

	it.each([
		["gemini-3-pro-preview", "minimal", { thinkingLevel: "LOW" }],
		["gemini-3-flash-preview", "max", { thinkingLevel: "HIGH" }],
		["gemini-2.5-flash", "medium", { thinkingBudget: 8192 }],
	] as const)("maps simple reasoning for %s at %s", async (modelId, reasoning, expectedThinking) => {
		let payload: unknown;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				sse({
					response: {
						candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
					},
				}),
			),
		);
		const provider = googleGeminiCliProvider();
		const model = provider.getModels().find((candidate) => candidate.id === modelId);
		expect(model, `missing ${modelId} from Google Gemini CLI catalog`).toBeDefined();
		const result = await provider
			.streamSimple(model!, context, {
				apiKey: JSON.stringify({ token: "access-secret", projectId: "project-123" }),
				reasoning,
				onPayload: (body) => {
					payload = body;
				},
			})
			.result();
		expect(result.stopReason).toBe("stop");
		expect(
			(payload as { request: { generationConfig?: { thinkingConfig?: Record<string, unknown> } } }).request
				.generationConfig?.thinkingConfig,
		).toMatchObject({ includeThoughts: true, ...expectedThinking });
	});

	it("parses CRLF-delimited SSE events", async () => {
		const first = JSON.stringify({
			response: { candidates: [{ content: { role: "model", parts: [{ text: "alpha-token" }] } }] },
		});
		const second = JSON.stringify({
			response: {
				candidates: [{ content: { role: "model", parts: [{ text: "beta-token" }] }, finishReason: "STOP" }],
			},
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(`data: ${first}\r\n\r\ndata: ${second}\r\n\r\n`, {
						status: 200,
						headers: { "Content-Type": "text/event-stream" },
					}),
			),
		);
		const provider = googleGeminiCliProvider();
		const text: string[] = [];
		for await (const event of provider.stream(provider.getModels()[0]!, context, {
			apiKey: JSON.stringify({ token: "access-secret", projectId: "project-123" }),
		})) {
			if (event.type === "text_end") text.push(event.content);
		}
		const joined = text.join("");
		expect(joined).toContain("alpha-token");
		expect(joined).toContain("beta-token");
	});
});
