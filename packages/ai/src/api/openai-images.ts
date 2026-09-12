import OpenAI from "openai";
import type { ImageEditParamsNonStreaming, ImageGenerateParamsNonStreaming } from "openai/resources/images.js";
import type {
	AssistantImages,
	ImageContent,
	ImagesContext,
	ImagesFunction,
	ImagesModel,
	ProviderHeaders,
	TextContent,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { headersToRecord } from "../utils/headers.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { resolveOpenAIClientAuth } from "./openai-client-auth.ts";
import { buildEditParams } from "./openai-images-edit.ts";
import { buildParams, isImageParams, type OpenAIImagesOptions } from "./openai-images-params.ts";
import { requestedOutputFormat, resolveImage } from "./openai-images-result.ts";

export {
	type OpenAIImageBackground,
	type OpenAIImageModeration,
	type OpenAIImageOutputFormat,
	type OpenAIImageQuality,
	type OpenAIImageSize,
	type OpenAIImagesOptions,
	parseOpenAIImageOutputOptions,
	parseOpenAIImageSize,
} from "./openai-images-params.ts";

const ENDPOINT_SUFFIXES = ["/chat/completions", "/responses", "/models"] as const;

export const generateImages: ImagesFunction<"openai-images", OpenAIImagesOptions> = async (
	model: ImagesModel<"openai-images">,
	context: ImagesContext,
	options?: OpenAIImagesOptions,
) => {
	const output: AssistantImages = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [],
		stopReason: "stop",
		timestamp: Date.now(),
	};

	try {
		let params = buildParams(model, context, options);
		const images = context.input.filter((item): item is ImageContent => item.type === "image");
		const method = images.length > 0 ? "edit" : "generate";
		if (method === "edit") params = await buildEditParams(params, images, options?.mask);
		const nextParams = await options?.onPayload?.(params, model);
		if (nextParams !== undefined) {
			if (!isImageParams(nextParams)) throw new Error("onPayload returned an invalid image generation payload");
			params = nextParams;
		}

		const headers: ProviderHeaders = { ...model.headers, ...options?.headers };
		const auth = resolveOpenAIClientAuth(model.provider, options?.apiKey, headers);
		const client = new OpenAI({
			apiKey: auth.apiKey,
			baseURL: normalizeBaseUrl(model.baseUrl),
			dangerouslyAllowBrowser: true,
			fetch: options?.fetch,
			defaultHeaders: auth.headers,
		});
		const requestOptions = {
			...(options?.signal ? { signal: options.signal } : {}),
			...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
			maxRetries: 0,
		};
		const { data: response, response: rawResponse } = await retryProviderRequest(
			() => {
				// openai SDK pinned at 6.26.0 predates gpt-image-2.5 quality tiers
				const sdkParams = params as ImageGenerateParamsNonStreaming & ImageEditParamsNonStreaming;
				return (
					method === "edit"
						? client.images.edit(sdkParams, requestOptions)
						: client.images.generate(sdkParams, requestOptions)
				).withResponse();
			},
			{
				maxRetries: options?.maxRetries,
				maxRetryDelayMs: options?.maxRetryDelayMs,
				signal: options?.signal,
			},
		);
		await options?.onResponse?.({ status: rawResponse.status, headers: headersToRecord(rawResponse.headers) }, model);

		if (response.usage) output.usage = parseUsage(response.usage, model);
		if (response.background === "transparent" || response.background === "opaque") {
			output.background = response.background;
		}
		if (!response.data || response.data.length === 0)
			throw new Error("OpenAI images response contained no image data");

		const outputFormat = requestedOutputFormat(params.output_format);
		for (const datum of response.data) {
			const image = await resolveImage(datum, outputFormat, options);
			if (datum.revised_prompt?.trim()) {
				output.output.push({ type: "text", text: datum.revised_prompt } satisfies TextContent);
			}
			output.output.push(image);
		}
		return output;
	} catch (error) {
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = formatProviderError(normalizeProviderError(error));
		return output;
	}
};

function normalizeBaseUrl(baseUrl: string): string {
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		throw new Error(`Invalid OpenAI images base URL: ${baseUrl}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("OpenAI images base URL must use HTTP or HTTPS");
	}
	if (url.search || url.hash) throw new Error("OpenAI images base URL must not include a query or fragment");
	const pathname = url.pathname.replace(/\/+$/, "");
	const normalizedPathname = pathname.toLowerCase();
	if (normalizedPathname.includes("/images")) {
		throw new Error("OpenAI images base URL must not include an images endpoint");
	}
	if (ENDPOINT_SUFFIXES.some((suffix) => normalizedPathname.endsWith(suffix))) {
		throw new Error("OpenAI images base URL must not include a known API endpoint");
	}
	url.pathname = pathname.endsWith("/v1") ? pathname : `${pathname}/v1`;
	return url.toString();
}

interface RawImageUsage {
	input_tokens?: number;
	input_tokens_details?: { image_tokens?: number; text_tokens?: number };
	output_tokens?: number;
	total_tokens?: number;
}

/** Image input tokens carry their own rate; without a breakdown every input token is text. */
function parseUsage(rawUsage: RawImageUsage, model: ImagesModel<"openai-images">) {
	const input = rawUsage.input_tokens ?? 0;
	const output = rawUsage.output_tokens ?? 0;
	const imageTokens = rawUsage.input_tokens_details?.image_tokens ?? 0;
	const textTokens = rawUsage.input_tokens_details?.text_tokens ?? Math.max(0, input - imageTokens);
	const imageRate = model.cost.imageInput ?? model.cost.input;
	const usage = {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: rawUsage.total_tokens ?? input + output,
		cost: {
			input: (model.cost.input * textTokens + imageRate * imageTokens) / 1_000_000,
			output: (model.cost.output / 1_000_000) * output,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
	usage.cost.total = usage.cost.input + usage.cost.output;
	return usage;
}
