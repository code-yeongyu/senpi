import { Type } from "typebox";
import { Value } from "typebox/value";
import { lazyStream } from "../api/lazy.ts";
import type {
	Api,
	DeferredHandle,
	Model,
	ProviderRequestOptions,
	ProviderStreams,
	SimpleStreamOptions,
	StreamOptions,
	TranscriptContext,
} from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { getCurrentTools, normalizeContext, toToolDeclaration } from "../utils/transcript.ts";

const toolDeclarationsSchema = Type.Array(
	Type.Object({
		name: Type.String(),
		description: Type.String(),
		parameters: Type.Record(Type.String(), Type.Unknown()),
	}),
);

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Feed a completed JSON answer through the existing SSE parser, including tools and usage. */
function completionResponse(value: Record<string, unknown>, headers?: Headers): Response {
	const choices = Array.isArray(value.choices) ? value.choices : [];
	const chunk = {
		...value,
		object: "chat.completion.chunk",
		choices: choices.map((choice: unknown, index) => {
			if (!record(choice)) throw new Error("Invalid Elorian completion choice");
			const message = record(choice.message) ? choice.message : {};
			const tools = Array.isArray(message.tool_calls) ? message.tool_calls : undefined;
			return {
				...choice,
				index,
				delta: {
					...message,
					...(tools
						? {
								tool_calls: tools.map((tool: unknown, toolIndex) => {
									if (!record(tool)) throw new Error("Invalid Elorian completion tool call");
									return { ...tool, index: toolIndex };
								}),
							}
						: {}),
				},
			};
		}),
	};
	return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
		headers: { ...Object.fromEntries(headers ?? []), "content-type": "text/event-stream" },
	});
}

function pendingResponse(headers?: Headers): Response {
	return completionResponse({ choices: [{ message: {}, finish_reason: "stop" }] }, headers);
}

function handleFor(model: Model<Api>, run: Record<string, unknown>, context: TranscriptContext): DeferredHandle {
	if (typeof run.id !== "string") throw new Error("Elorian run response is missing id");
	const tools = getCurrentTools(context.messages);
	return {
		provider: model.provider,
		modelId: model.id,
		api: model.api,
		id: run.id,
		pollAfterMs: 5_000,
		...(tools.length ? { data: JSON.stringify(tools.map(toToolDeclaration)) } : {}),
	};
}

function validateHandle(model: Model<Api>, handle: DeferredHandle): void {
	if (handle.provider !== model.provider || handle.modelId !== model.id || handle.api !== model.api) {
		throw new Error("Elorian run handle belongs to a different model");
	}
}

function runHeaders(model: Model<Api>, options: ProviderRequestOptions): Headers {
	const headers = new Headers();
	if (options.apiKey) headers.set("authorization", `Bearer ${options.apiKey}`);
	for (const source of [model.headers, options.headers]) {
		for (const [key, value] of Object.entries(source ?? {})) {
			if (value === null) headers.delete(key);
			else headers.set(key, value);
		}
	}
	return headers;
}

/** Connect Elorian's queued runs to Senpi's existing deferred-response lifecycle. */
export function withElorianRuns(streams: ProviderStreams): ProviderStreams {
	const forward = (
		inner: AssistantMessageEventStream,
		getHandle: () => DeferredHandle | undefined,
		signal?: AbortSignal,
	): AssistantMessageEventStream => {
		const outer = new AssistantMessageEventStream();
		void (async () => {
			try {
				for await (const event of inner) {
					const handle = getHandle();
					if (event.type === "done" && handle) {
						outer.push({
							type: "done",
							reason: "deferred",
							message: { ...event.message, stopReason: "deferred", deferred: handle },
						});
					} else if (event.type === "error" && signal?.aborted) {
						outer.push({ ...event, reason: "aborted", error: { ...event.error, stopReason: "aborted" } });
					} else {
						outer.push(event);
					}
				}
				outer.end();
			} catch (error) {
				outer.fail(error);
			}
		})();
		return outer;
	};
	const start = (
		simple: boolean,
		model: Model<Api>,
		context: TranscriptContext,
		options: SimpleStreamOptions = {},
	): AssistantMessageEventStream => {
		let background = false;
		let handle: DeferredHandle | undefined;
		const fetchImpl = options.fetch ?? globalThis.fetch;
		const runOptions: StreamOptions = {
			...options,
			onPayload: async (payload, target, request) => {
				const value = (await options.onPayload?.(payload, target, request)) ?? payload;
				if (!record(value)) throw new Error("Elorian completion payload must be an object");
				background = !!options.deferred || value.background === true;
				if (!background) return value;
				const { background: _background, ...body } = value;
				return body;
			},
			fetch: async (input, init) => {
				const request = new Request(input, init);
				if (!background || !new URL(request.url).pathname.endsWith("/chat/completions")) return fetchImpl(request);
				const body: unknown = await request.json();
				if (!record(body)) throw new Error("Elorian completion payload must be an object");
				const response = await fetchImpl(
					new Request(request, { body: JSON.stringify({ ...body, stream: false, background: true }) }),
				);
				if (!response.ok) return response;
				const run: unknown = await response.json();
				if (!record(run)) throw new Error("Invalid Elorian run response");
				if (run.status !== "queued" && run.status !== "in_progress") {
					throw new Error(`Unexpected initial Elorian run status: ${String(run.status)}`);
				}
				handle = handleFor(model, run, context);
				return pendingResponse(response.headers);
			},
		};
		const inner = simple
			? streams.streamSimple(model, context, { ...options, ...runOptions })
			: streams.stream(model, context, runOptions);
		return forward(inner, () => handle, options.signal);
	};
	return {
		stream: (model, context, options) => start(false, model, context, options),
		streamSimple: (model, context, options) => start(true, model, context, options),
		fetchDeferred: (model, handle, options = {}) => {
			let pending: DeferredHandle | undefined;
			const inner = lazyStream(model, async () => {
				validateHandle(model, handle);
				const tools =
					handle.data === undefined
						? []
						: Value.Parse(toolDeclarationsSchema, JSON.parse(Value.Parse(Type.String(), handle.data)));
				const signal = AbortSignal.any([
					...(options.signal ? [options.signal] : []),
					AbortSignal.timeout(options.timeoutMs ?? 600_000),
				]);
				const response = await (options.fetch ?? globalThis.fetch)(
					`${model.baseUrl.replace(/\/+$/u, "")}/runs/${encodeURIComponent(handle.id)}`,
					{ headers: runHeaders(model, options), signal },
				);
				if (!response.ok) throw new Error(`Elorian run retrieval failed: HTTP ${response.status}`);
				const run: unknown = await response.json();
				if (!record(run)) throw new Error("Invalid Elorian run response");
				let completion: Response;
				let hasNativeCalls = false;
				switch (run.status) {
					case "queued":
					case "in_progress":
						pending = handle;
						completion = pendingResponse(response.headers);
						break;
					case "completed":
						if (!record(run.completion)) throw new Error("Completed Elorian run has no completion");
						hasNativeCalls =
							Array.isArray(run.completion.choices) &&
							run.completion.choices.some(
								(choice: unknown) =>
									record(choice) &&
									record(choice.message) &&
									Array.isArray(choice.message.tool_calls) &&
									choice.message.tool_calls.length > 0,
							);
						completion = completionResponse(run.completion, response.headers);
						break;
					case "failed":
					case "cancelled":
						throw new Error(`Elorian run ${run.status}: ${JSON.stringify(run.error ?? run.last_error ?? "")}`);
					default:
						throw new Error(`Unknown Elorian run status: ${String(run.status)}`);
				}
				const { background: _background, ...samplingParams } = model.samplingParams ?? {};
				return streams.streamSimple(
					{ ...model, samplingParams },
					normalizeContext({ messages: [], tools: hasNativeCalls ? [] : tools }),
					{
						...options,
						fetch: async () => completion,
						maxRetries: 0,
					},
				);
			});
			return forward(inner, () => pending, options.signal);
		},
		cancelDeferred: async (model, handle, options = {}) => {
			validateHandle(model, handle);
			const signal = AbortSignal.any([
				...(options.signal ? [options.signal] : []),
				AbortSignal.timeout(options.timeoutMs ?? 15_000),
			]);
			const response = await (options.fetch ?? globalThis.fetch)(
				`${model.baseUrl.replace(/\/+$/u, "")}/runs/${encodeURIComponent(handle.id)}/cancel`,
				{ method: "POST", headers: runHeaders(model, options), signal },
			);
			if (!response.ok) throw new Error(`Elorian run cancellation failed: HTTP ${response.status}`);
		},
	};
}
