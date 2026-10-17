import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import {
	getProtocol,
	getToolCallFormat,
	transformContext,
	wrapStreamWithToolCallMiddleware,
} from "../tool-call-middleware/index.ts";
import type {
	Api,
	AssistantMessage,
	Model,
	OpenAICompletionsCompat,
	ProviderNativeContent,
	ProviderStreams,
	SimpleStreamOptions,
	StreamOptions,
	TranscriptContext,
} from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { getCurrentTools, normalizeContext } from "../utils/transcript.ts";
import { type ElorianFileOptions, uploadElorianVideo } from "./elorian-files.ts";

export type ElorianHostedTool = {
	type: "calculator" | "current_time" | "code_interpreter" | "web_search" | "visual_search";
};

export interface ElorianCompletionsOptions extends ElorianFileOptions {
	hostedTools?: readonly ElorianHostedTool[];
}

export const ELORIAN_COMPLETIONS_COMPAT = {
	maxTokensField: "max_completion_tokens",
	supportsDisabledThinking: false,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	supportsStore: true,
	thinkingFormat: "openai",
} satisfies OpenAICompletionsCompat;

export const ELORIAN_THINKING_LEVEL_MAP = {
	off: null,
	minimal: null,
	low: "low",
	medium: "medium",
	high: null,
	xhigh: "xhigh",
	max: null,
} satisfies NonNullable<Model<"openai-completions">["thinkingLevelMap"]>;

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hostedTools(value: unknown): ElorianHostedTool[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("elorian_hosted_tools must be an array");
	return value.map((tool: unknown) => {
		if (
			!record(tool) ||
			!["calculator", "current_time", "code_interpreter", "web_search", "visual_search"].includes(String(tool.type))
		) {
			throw new Error("Invalid Elorian hosted tool");
		}
		switch (tool.type) {
			case "calculator":
			case "current_time":
			case "code_interpreter":
			case "web_search":
			case "visual_search":
				return { type: tool.type };
			default:
				throw new Error("Invalid Elorian hosted tool");
		}
	});
}

/** Adds Elorian native features without introducing another API or replacing completions parsing. */
export function elorianCompletionsApi(config: ElorianCompletionsOptions = {}): ProviderStreams {
	const streams = openAICompletionsApi();
	// Ready IDs only: failures and caller aborts never poison another request. Bounded per adapter.
	const videos = new Map<string, string>();
	const wrap = (
		simple: boolean,
		model: Model<Api>,
		context: TranscriptContext,
		options: SimpleStreamOptions = {},
	): AssistantMessageEventStream => {
		const format = getToolCallFormat(model) ?? "morph-xml";
		const tools = getCurrentTools(context.messages);
		const protocol = format && tools.length > 0 ? getProtocol(format) : undefined;
		// Elorian's hosted agent otherwise tries to execute client tool names remotely.
		// Keep the handoff in a user turn; native images/video pass through unchanged.
		const transformed = protocol
			? transformContext(context, { ...protocol, formatToolsSystemPrompt: () => "" })
			: context;
		const requestContext = protocol
			? normalizeContext({
					messages: [
						...transformed.messages,
						{
							role: "user",
							timestamp: 0,
							content: `Client-side tool handoff: the functions below run on the external client, NOT in your hosted tool runtime. Do not invoke these names as hosted tools. To request a client action, emit its XML call literally in your FINAL VISIBLE ANSWER; the client executes that text and returns a tool_response. Your hosted Python cannot access client-local files. If a client tool_response already supplies the information needed for the task, use that result and answer normally. Otherwise request the needed client action as literal XML, rather than reporting that your hosted dispatcher lacks the function.\n\n${protocol.formatToolsSystemPrompt(tools)}`,
						},
					],
				})
			: context;
		const outer = new AssistantMessageEventStream();
		const native: ProviderNativeContent[] = [];
		let output: AssistantMessage | undefined;
		let innerOutput: AssistantMessage | undefined;
		const merge = (message: AssistantMessage): AssistantMessage => {
			innerOutput = message;
			const merged = { ...message, content: [...message.content, ...native] };
			if (output) Object.assign(output, merged);
			else output = merged;
			return output;
		};
		void (async () => {
			try {
				const streamOptions: StreamOptions = {
					...options,
					onPayload: async (payload, target, request) => {
						const overridden = await options.onPayload?.(payload, target, request);
						const body = overridden ?? payload;
						if (!record(body)) throw new Error("Elorian completion payload must be an object");
						if (body.background === true)
							throw new Error("Elorian background:true is not a streaming completion");
						if (
							body.reasoning_effort !== undefined &&
							!["low", "medium", "xhigh"].includes(String(body.reasoning_effort))
						) {
							throw new Error("Elorian reasoning_effort must be low, medium, or xhigh");
						}
						const tools = [...hostedTools(config.hostedTools), ...hostedTools(body.elorian_hosted_tools)];
						const result = { ...body };
						delete result.elorian_hosted_tools;
						if (tools.length) result.tools = [...(Array.isArray(body.tools) ? body.tools : []), ...tools];
						if (Array.isArray(body.messages)) {
							result.messages = await Promise.all(
								body.messages.map(async (message: unknown) => {
									if (!record(message) || !Array.isArray(message.content)) return message;
									const content = [];
									for (const part of message.content) {
										if (
											record(part) &&
											part.type === "video_url" &&
											record(part.video_url) &&
											typeof part.video_url.url === "string" &&
											part.video_url.url.startsWith("data:")
										) {
											throw new Error(
												"Elorian video_url requires an HTTPS URL or file://id, not inline data",
											);
										}
										if (
											!record(part) ||
											part.type !== "image_url" ||
											!record(part.image_url) ||
											typeof part.image_url.url !== "string"
										) {
											content.push(part);
											continue;
										}
										const url = part.image_url.url;
										const inline = /^data:(video\/[^;,]+);base64,([\s\S]*)$/.exec(url);
										if (!inline) {
											if (url.startsWith("data:video/"))
												throw new Error("Elorian inline video must use base64 encoding");
											content.push(part);
											continue;
										}
										const mime = inline[1];
										const data = inline[2];
										const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
										const hash = Array.from(
											new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
											(byte) => byte.toString(16).padStart(2, "0"),
										).join("");
										// Never reuse an ID across endpoint or credential scopes.
										const auth = JSON.stringify([
											model.baseUrl,
											options.apiKey,
											model.headers,
											options.headers,
											mime,
										]);
										const scope = Array.from(
											new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(auth))),
											(byte) => byte.toString(16).padStart(2, "0"),
										).join("");
										const key = `${scope}:${hash}`;
										let uploaded = videos.get(key);
										if (!uploaded) {
											uploaded = await uploadElorianVideo(
												new Blob([bytes], { type: mime }),
												model,
												options,
												config,
											);
											if (videos.size >= 32) {
												const oldest = videos.keys().next().value;
												if (oldest !== undefined) videos.delete(oldest);
											}
											videos.set(key, uploaded);
										}
										content.push({ type: "video_url", video_url: { url: uploaded } });
									}
									return { ...message, content };
								}),
							);
						}
						return result;
					},
					onProviderStreamEvent: async (data, target) => {
						if (record(data)) {
							if (data.elorian !== undefined)
								native.push({ type: "providerNative", subtype: "elorian", raw: data.elorian });
							if (record(data.usage) && data.usage.elorian !== undefined) {
								native.push({ type: "providerNative", subtype: "usage.elorian", raw: data.usage.elorian });
							}
							if (innerOutput) merge(innerOutput);
						}
						await options.onProviderStreamEvent?.(data, target);
					},
				};
				const raw = simple
					? streams.streamSimple(model, requestContext, { ...options, ...streamOptions })
					: streams.stream(model, requestContext, streamOptions);
				const inner = protocol
					? wrapStreamWithToolCallMiddleware(raw, protocol, tools, { preserveSourceMetadata: true })
					: raw;
				for await (const event of inner) {
					if (event.type === "done") outer.push({ ...event, message: merge(event.message) });
					else if (event.type === "error") outer.push({ ...event, error: merge(event.error) });
					else outer.push({ ...event, partial: merge(event.partial) });
				}
				outer.end();
			} catch (error) {
				const message: AssistantMessage = output ?? {
					role: "assistant",
					content: native,
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "error",
					timestamp: Date.now(),
				};
				message.stopReason = options.signal?.aborted ? "aborted" : "error";
				message.errorMessage = error instanceof Error ? error.message : String(error);
				outer.push({ type: "error", reason: message.stopReason, error: message });
				outer.end();
			}
		})();
		return outer;
	};
	return {
		stream: (model, context, options) => wrap(false, model, context, options),
		streamSimple: (model, context, options) => wrap(true, model, context, options),
	};
}
