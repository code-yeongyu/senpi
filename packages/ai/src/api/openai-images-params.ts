import type { Uploadable } from "openai";
import type { ImageGenerateParamsNonStreaming } from "openai/resources/images.js";
import type { ImageContent, ImagesContext, ImagesModel, ImagesOptions } from "../types.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";

const MAX_PROMPT_CHARS = 32_000;

export type OpenAIImageQuality = "auto" | "low" | "medium" | "high" | "xhigh" | "max";
export type OpenAIImageSize = "auto" | "1024x1024" | "1536x1024" | "1024x1536" | `${number}x${number}`;
export type OpenAIImageBackground = "auto" | "transparent" | "opaque";
export type OpenAIImageOutputFormat = "png" | "jpeg" | "webp";
export type OpenAIImageModeration = "auto" | "low";

export interface OpenAIImagesOptions extends ImagesOptions {
	size?: OpenAIImageSize;
	quality?: OpenAIImageQuality;
	n?: number;
	/** Output transparency. `transparent` requires `outputFormat` png or webp. */
	background?: OpenAIImageBackground;
	/** Container of the returned bytes. Default png. */
	outputFormat?: OpenAIImageOutputFormat;
	/** 0-100 compression for jpeg/webp output only. */
	outputCompression?: number;
	moderation?: OpenAIImageModeration;
	/** Inpainting mask applied to the first input image; requires at least one image input. */
	mask?: ImageContent;
}

export type OpenAIImageParams = Omit<ImageGenerateParamsNonStreaming, "size" | "quality"> & {
	size?: OpenAIImageSize;
	quality?: OpenAIImageQuality;
	image?: Uploadable[];
	mask?: Uploadable;
};

export function parseOpenAIImageSize(size: string): { ok: true; size: string } | { ok: false; error: string } {
	if (["auto", "1024x1024", "1536x1024", "1024x1536"].includes(size)) return { ok: true, size };
	const match = /^\d+x\d+$/.exec(size);
	if (!match || match[0] !== size) {
		return { ok: false, error: "OpenAI image size must be auto or WIDTHxHEIGHT with integer dimensions" };
	}
	const [width, height] = size.split("x").map(Number);
	if (width > 3840 || height > 3840) {
		return { ok: false, error: "OpenAI image size edges must be at most 3840 pixels" };
	}
	if (width % 16 !== 0 || height % 16 !== 0) {
		return { ok: false, error: "OpenAI image size width and height must be divisible by 16" };
	}
	if (width > height * 3 || height > width * 3) {
		return { ok: false, error: "OpenAI image size aspect ratio must be between 1:3 and 3:1 inclusive" };
	}
	const pixels = width * height;
	if (pixels < 655360 || pixels > 8294400) {
		return { ok: false, error: "OpenAI image size must contain between 655360 and 8294400 pixels inclusive" };
	}
	return { ok: true, size };
}

export interface OpenAIImageOutputOptionsInput {
	background?: OpenAIImageBackground | undefined;
	outputFormat?: OpenAIImageOutputFormat | undefined;
	outputCompression?: number | undefined;
	/** Whether an inpainting mask accompanies the request. */
	hasMask: boolean;
	/** Number of image inputs (references or edit targets) in the request. */
	imageCount: number;
}

export type OpenAIImageOutputOptions =
	| { ok: true; outputFormat: OpenAIImageOutputFormat }
	| { ok: false; error: string };

/**
 * Validates the output-shaping options before any request leaves the process.
 * Mirrors the Images API contract: transparency needs an alpha-capable container,
 * compression is a jpeg/webp-only integer percentage, and a mask edits an image.
 */
export function parseOpenAIImageOutputOptions(input: OpenAIImageOutputOptionsInput): OpenAIImageOutputOptions {
	const outputFormat = input.outputFormat ?? "png";
	if (input.background === "transparent" && outputFormat === "jpeg") {
		return { ok: false, error: "OpenAI image background transparent requires output_format png or webp" };
	}
	if (input.outputCompression !== undefined) {
		if (outputFormat === "png") {
			return { ok: false, error: "OpenAI image output_compression requires output_format jpeg or webp" };
		}
		if (!Number.isInteger(input.outputCompression) || input.outputCompression < 0 || input.outputCompression > 100) {
			return { ok: false, error: "OpenAI image output_compression must be an integer between 0 and 100" };
		}
	}
	if (input.hasMask && input.imageCount === 0) {
		return { ok: false, error: "OpenAI image mask requires at least one input image" };
	}
	return { ok: true, outputFormat };
}

export function buildParams(
	model: ImagesModel<"openai-images">,
	context: ImagesContext,
	options?: OpenAIImagesOptions,
): OpenAIImageParams {
	const promptParts: string[] = [];
	for (const item of context.input) {
		if (item.type !== "text") continue;
		const text = sanitizeSurrogates(item.text);
		if (text.trim()) promptParts.push(text);
	}
	const prompt = promptParts.join("\n\n");
	if (!prompt.trim()) throw new Error("Image generation requires a non-empty text prompt");
	if (prompt.length > MAX_PROMPT_CHARS) {
		throw new Error(`Image generation prompt exceeds ${MAX_PROMPT_CHARS} characters`);
	}
	const size = options?.size ?? "auto";
	const parsedSize = parseOpenAIImageSize(size);
	if (!parsedSize.ok) throw new Error(parsedSize.error);
	const output = parseOpenAIImageOutputOptions({
		background: options?.background,
		outputFormat: options?.outputFormat,
		outputCompression: options?.outputCompression,
		hasMask: options?.mask !== undefined,
		imageCount: context.input.filter((item) => item.type === "image").length,
	});
	if (!output.ok) throw new Error(output.error);
	return {
		model: model.id,
		prompt,
		size,
		quality: options?.quality ?? "auto",
		n: options?.n ?? 1,
		output_format: output.outputFormat,
		stream: false,
		...(options?.background === undefined ? {} : { background: options.background }),
		...(options?.outputCompression === undefined ? {} : { output_compression: options.outputCompression }),
		...(options?.moderation === undefined ? {} : { moderation: options.moderation }),
	};
}

export function isImageParams(value: unknown): value is OpenAIImageParams {
	return typeof value === "object" && value !== null && "prompt" in value && typeof value.prompt === "string";
}
