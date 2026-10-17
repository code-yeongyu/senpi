import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSimple as compatStreamSimple } from "../src/compat.ts";
import { uploadElorianVideo } from "../src/providers/elorian-files.ts";
import {
	ELORIAN_COMPLETIONS_COMPAT,
	ELORIAN_THINKING_LEVEL_MAP,
	elorianCompletionsApi,
} from "../src/providers/elorian-stream.ts";
import type { AssistantMessageEvent, Model, StreamOptions } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-completions"> = {
	id: "elorian",
	name: "Elorian",
	api: "openai-completions",
	provider: "elorian",
	baseUrl: "https://elorian.invalid/v1",
	reasoning: true,
	input: ["text", "image", "video"],
	contextWindow: 100000,
	maxTokens: 10000,
	cost: { input: 0.6, cacheRead: 0.06, output: 3, cacheWrite: 0 },
	compat: ELORIAN_COMPLETIONS_COMPAT,
	thinkingLevelMap: ELORIAN_THINKING_LEVEL_MAP,
};
const context = normalizeContext({
	systemPrompt: "Instructions",
	messages: [{ role: "user", content: "Hello", timestamp: 0 }],
	tools: [{ name: "local", description: "Local function", parameters: Type.Object({ n: Type.Number() }) }],
});

function sse(chunks: unknown[]): Response {
	return new Response([...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), "data: [DONE]\n\n"].join(""), {
		headers: { "Content-Type": "text/event-stream" },
	});
}

function done(): Response {
	return sse([{ id: "chat", choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] }]);
}

function request(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Request {
	return new Request(input, init);
}

const videoContext = normalizeContext({
	messages: [
		{
			role: "user",
			timestamp: 0,
			content: [{ type: "image", mimeType: "video/mp4", data: btoa("clip") }],
		},
	],
});

afterEach(() => vi.useRealTimers());

describe("Elorian completions native adapter", () => {
	it("preserves Elorian usage and native metadata through the public compatibility dispatcher", async () => {
		const result = await compatStreamSimple({ ...model, id: "elorian-1-agent" }, context, {
			apiKey: "fake",
			maxRetries: 0,
			fetch: async () =>
				sse([
					{
						choices: [
							{
								index: 0,
								delta: { content: "<local><n>1</n></local>" },
								finish_reason: "stop",
							},
						],
						usage: {
							prompt_tokens: 5,
							completion_tokens: 4,
							total_tokens: 9,
							completion_tokens_details: { reasoning_tokens: 3 },
						},
						elorian: { progress: "finished" },
					},
				]),
		}).result();
		expect(result.stopReason).toBe("toolUse");
		expect(result.usage.reasoning).toBe(3);
		expect(result.content).toContainEqual({
			type: "providerNative",
			subtype: "elorian",
			raw: { progress: "finished" },
		});
	});

	it("encodes local tools as text while preserving native media, hosted tools, reasoning and provenance", async () => {
		// Given: real completions transport with an HTTP-only fake.
		const bodies: unknown[] = [];
		const chunks = [
			{ id: "chat", choices: [], elorian: { progress: "searching", files: [{ id: "f" }] } },
			{ id: "chat", choices: [{ delta: { reasoning_content: "Think" }, finish_reason: null }] },
			{ id: "chat", choices: [{ delta: { content: "Answer" }, finish_reason: null }] },
			{
				id: "chat",
				choices: [
					{
						delta: { content: "<local><n>1</n></local>" },
						finish_reason: "stop",
					},
				],
			},
			{
				id: "chat",
				choices: [],
				usage: {
					prompt_tokens: 12,
					completion_tokens: 5,
					total_tokens: 17,
					prompt_tokens_details: { cached_tokens: 2 },
					completion_tokens_details: { reasoning_tokens: 3 },
					elorian: { provenance: "native" },
				},
			},
		];
		const observer = vi.fn();
		const options: StreamOptions = {
			apiKey: "fake",
			maxRetries: 0,
			fetch: async (input, init) => {
				bodies.push(await request(input, init).json());
				return sse(chunks);
			},
			extraBody: {
				elorian_hosted_tools: [{ type: "web_search" }],
				video_fps: 2,
				pixels_per_frame: 1024,
				mode: "max",
			},
			onProviderStreamEvent: observer,
		};
		const adapter = elorianCompletionsApi({ hostedTools: [{ type: "calculator" }] });
		// When: stream through both entry points.
		const image = { type: "image" as const, data: btoa("pixel"), mimeType: "image/png" };
		const visualContext = normalizeContext({
			messages: [...context.messages, { role: "user" as const, content: [image], timestamp: 1 }],
		});
		const stream = adapter.streamSimple(model, visualContext, { ...options, reasoning: "xhigh" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();
		// Then: serialized native fields coexist with the ordinary transport behavior.
		expect(bodies[0]).toMatchObject({
			reasoning_effort: "xhigh",
			stream: true,
			stream_options: { include_usage: true },
			store: false,
			messages: [{ role: "developer" }, { role: "user" }],
			tools: [{ type: "calculator" }, { type: "web_search" }],
			video_fps: 2,
			pixels_per_frame: 1024,
			mode: "max",
		});
		expect(bodies[0]).not.toHaveProperty("elorian_hosted_tools");
		expect(bodies[0]).toMatchObject({
			messages: expect.arrayContaining([
				{
					role: "user",
					content: expect.arrayContaining([
						{ type: "image_url", image_url: { url: `data:image/png;base64,${image.data}` } },
						// The hosted agent requires this machine-consumed protocol marker in a user turn.
						{ type: "text", text: expect.stringContaining("<tools>") },
					]),
				},
			]),
		});
		expect(observer).toHaveBeenCalledTimes(chunks.length);
		expect(result.stopReason).toBe("toolUse");
		expect(result.usage).toMatchObject({ input: 10, output: 5, cacheRead: 2, reasoning: 3, totalTokens: 17 });
		expect(result.content).toEqual(
			expect.arrayContaining([
				{ type: "text", text: "Answer" },
				expect.objectContaining({ type: "thinking", thinking: "Think" }),
				expect.objectContaining({ type: "toolCall", name: "local", arguments: { n: 1 } }),
				{ type: "providerNative", subtype: "elorian", raw: chunks[0].elorian },
				{ type: "providerNative", subtype: "usage.elorian", raw: { provenance: "native" } },
			]),
		);
		for (const event of events) {
			if ("contentIndex" in event && event.type.startsWith("toolcall")) {
				expect(result.content[event.contentIndex]?.type).toBe("toolCall");
			}
		}
		expect(events.map((event) => event.type)).toEqual(
			expect.arrayContaining(["thinking_delta", "text_delta", "toolcall_end", "done"]),
		);
	});

	it("uploads inline videos, awaits readiness, and reuses ready files on follow-up", async () => {
		// Given: a processing upload, with timers controlling the API retrieval interval.
		vi.useFakeTimers();
		const bodies: unknown[] = [];
		let uploads = 0;
		let notifyUpload: () => void = () => {};
		const uploaded = new Promise<void>((resolve) => {
			notifyUpload = resolve;
		});
		const fetcher: typeof fetch = async (input, init) => {
			const req = request(input, init);
			expect(req.headers.get("authorization")).toBe("Bearer fake");
			if (req.url.endsWith("/files")) {
				const form = await req.formData();
				expect(form.get("purpose")).toBe("vision");
				const clip = form.get("file");
				expect(clip).toBeInstanceOf(Blob);
				if (clip instanceof Blob) expect(await clip.text()).toBe("clip");
				uploads++;
				notifyUpload();
				return Response.json({ id: "clip-id", status: "processing" });
			}
			if (req.url.endsWith("/files/clip-id")) return Response.json({ id: "clip-id", status: "ready" });
			bodies.push(await req.json());
			return done();
		};
		const adapter = elorianCompletionsApi();
		const options = { apiKey: "fake", fetch: fetcher, maxRetries: 0 };
		// When: the processing state advances, followed by another turn containing the clip.
		const first = adapter.stream(model, videoContext, options);
		await uploaded;
		await vi.runOnlyPendingTimersAsync();
		expect((await first.result()).stopReason).toBe("stop");
		expect((await adapter.stream(model, videoContext, options).result()).stopReason).toBe("stop");
		// Then: the wire uses a ready native video reference and does not re-upload history.
		expect(uploads).toBe(1);
		expect(bodies).toHaveLength(2);
		for (const body of bodies) {
			expect(body).toMatchObject({
				messages: [{ content: [{ type: "video_url", video_url: { url: "file://clip-id" } }] }],
			});
			expect(JSON.stringify(body)).not.toContain("data:video");
		}
		expect(videoContext.messages[0]).toMatchObject({ content: [{ data: btoa("clip") }] });
	});

	it.each([{ background: true }, { elorian_hosted_tools: [{ type: "unknown" }] }])(
		"rejects unsupported native requests before HTTP: %j",
		async (extraBody) => {
			const fetcher = vi.fn<typeof fetch>();
			const result = await elorianCompletionsApi()
				.stream(model, context, { apiKey: "fake", fetch: fetcher, extraBody })
				.result();
			expect(result.stopReason).toBe("error");
			expect(fetcher).not.toHaveBeenCalled();
		},
	);

	it("rejects unsupported reasoning inserted by the payload callback", async () => {
		const fetcher = vi.fn<typeof fetch>();
		const result = await elorianCompletionsApi()
			.stream(model, context, {
				apiKey: "fake",
				fetch: fetcher,
				onPayload: () => ({ reasoning_effort: "high" }),
			})
			.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("reasoning_effort");
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("consumes persistent sampling defaults after generic request overrides", async () => {
		let body: unknown;
		const configuredModel = {
			...model,
			samplingParams: {
				video_fps: 5,
				pixels_per_frame: 200000,
				mode: "max",
				elorian_hosted_tools: [{ type: "visual_search" }],
			},
		};
		const result = await elorianCompletionsApi()
			.streamSimple(configuredModel, context, {
				apiKey: "fake",
				samplingParams: { video_fps: 8 },
				fetch: async (input, init) => {
					body = await request(input, init).json();
					return done();
				},
			})
			.result();
		expect(result.stopReason).toBe("stop");
		expect(body).toMatchObject({
			video_fps: 8,
			pixels_per_frame: 200000,
			mode: "max",
			tools: [{ type: "visual_search" }],
		});
		expect(body).not.toHaveProperty("elorian_hosted_tools");
		expect(configuredModel.samplingParams.elorian_hosted_tools).toEqual([{ type: "visual_search" }]);
	});

	it("rejects inline data in a native video URL before HTTP", async () => {
		const fetcher = vi.fn<typeof fetch>();
		const result = await elorianCompletionsApi()
			.stream(model, context, {
				apiKey: "fake",
				fetch: fetcher,
				onPayload: () => ({
					messages: [
						{ role: "user", content: [{ type: "video_url", video_url: { url: "data:video/mp4;base64,YQ==" } }] },
					],
				}),
			})
			.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("video_url");
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("preserves native URL video parts supplied by the payload callback", async () => {
		const videos = [
			{ type: "video_url", video_url: { url: "https://example.invalid/clip.mp4" } },
			{ type: "video_url", video_url: { url: "file://existing" } },
		];
		let body: unknown;
		const result = await elorianCompletionsApi()
			.stream(model, context, {
				apiKey: "fake",
				onPayload: () => ({ model: model.id, stream: true, messages: [{ role: "user", content: videos }] }),
				fetch: async (input, init) => {
					body = await request(input, init).json();
					return done();
				},
			})
			.result();
		expect(result.stopReason).toBe("stop");
		expect(body).toMatchObject({ messages: [{ content: videos }] });
	});

	it("preserves native metadata when an SSE error terminates the response", async () => {
		const result = await elorianCompletionsApi()
			.stream(model, context, {
				apiKey: "fake",
				maxRetries: 0,
				fetch: async () =>
					sse([{ choices: [], elorian: { progress: "running" } }, { error: { message: "remote failure" } }]),
			})
			.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("remote failure");
		expect(result.content).toContainEqual({
			type: "providerNative",
			subtype: "elorian",
			raw: { progress: "running" },
		});
	});

	it("reports failed file processing without starting a completion", async () => {
		const urls: string[] = [];
		const result = await elorianCompletionsApi()
			.stream(model, videoContext, {
				apiKey: "fake",
				fetch: async (input, init) => {
					urls.push(request(input, init).url);
					return Response.json({ id: "bad", status: "failed", last_error: { message: "invalid video" } });
				},
			})
			.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("invalid video");
		expect(urls).toEqual(["https://elorian.invalid/v1/files"]);
	});

	it("aborts processing waits and does not cache unfinished files", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		let notify: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			notify = resolve;
		});
		const fetcher = vi.fn<typeof fetch>(async () => {
			notify();
			return Response.json({ id: "pending", status: "processing" });
		});
		const stream = elorianCompletionsApi().stream(model, videoContext, {
			apiKey: "fake",
			fetch: fetcher,
			signal: controller.signal,
		});
		await started;
		controller.abort();
		expect((await stream.result()).stopReason).toBe("aborted");
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("bounds processing time even without a caller abort", async () => {
		vi.useFakeTimers();
		let notify: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			notify = resolve;
		});
		const result = uploadElorianVideo(
			new Blob(["clip"], { type: "video/mp4" }),
			model,
			{
				apiKey: "fake",
				fetch: async () => {
					notify();
					return Response.json({ id: "pending", status: "processing" });
				},
			},
			{ fileTimeoutMs: 20, filePollIntervalMs: 1000 },
		);
		const rejection = expect(result).rejects.toThrow();
		await started;
		await vi.advanceTimersByTimeAsync(20);
		await rejection;
	});

	it("uploads large clips in ordered parts no larger than 64 MiB", async () => {
		// Given: immutable Blob references share a one MiB block; no huge fixture is read.
		const block = new Blob([new Uint8Array(1024 * 1024)]);
		const clip = new Blob(
			Array.from({ length: 513 }, () => block),
			{ type: "video/mp4" },
		);
		const sizes: number[] = [];
		let completed: unknown;
		const fetcher: typeof fetch = async (input, init) => {
			const url = String(input);
			if (url.endsWith("/uploads")) {
				expect(JSON.parse(String(init?.body))).toMatchObject({
					bytes: 513 * 1024 * 1024,
					mime_type: "video/mp4",
					purpose: "vision",
				});
				return Response.json({ id: "upload" });
			}
			if (url.endsWith("/parts")) {
				expect(init?.body).toBeInstanceOf(FormData);
				const part = init?.body instanceof FormData ? init.body.get("data") : undefined;
				if (!(part instanceof Blob)) throw new Error("Expected multipart data");
				sizes.push(part.size);
				return Response.json({ id: `part-${sizes.length}` });
			}
			completed = JSON.parse(String(init?.body));
			return Response.json({ file: { id: "large", status: "ready" } });
		};
		// When: the large file crosses the real uploader's HTTP boundary.
		const url = await uploadElorianVideo(clip, model, { apiKey: "fake", fetch: fetcher });
		// Then: all bytes are partitioned in order and completion names every part.
		expect(url).toBe("file://large");
		expect(sizes).toEqual([...Array.from({ length: 8 }, () => 64 * 1024 * 1024), 1024 * 1024]);
		expect(completed).toEqual({ part_ids: Array.from({ length: 9 }, (_, index) => `part-${index + 1}`) });
	});
});
