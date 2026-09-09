import type { Uploadable } from "openai";
import type { ImageGenerateParamsNonStreaming } from "openai/resources/images.js";
import type { ImagesContext, ImagesModel, ImagesOptions } from "../types.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";

const MAX_PROMPT_CHARS = 32_000;

export type OpenAIImageQuality = "auto" | "low" | "medium" | "high" | "xhigh" | "max";
export type OpenAIImageSize = "auto" | "1024x1024" | "1536x1024" | "1024x1536" | `${number}x${number}`;

export interface OpenAIImagesOptions extends ImagesOptions {
	size?: OpenAIImageSize;
	quality?: OpenAIImageQuality;
	n?: number;
}

export type OpenAIImageParams = Omit<ImageGenerateParamsNonStreaming, "size" | "quality"> & {
	size?: OpenAIImageSize;
	quality?: OpenAIImageQuality;
	image?: Uploadable[];
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
	return {
		model: model.id,
		prompt,
		size,
		quality: options?.quality ?? "auto",
		n: options?.n ?? 1,
		output_format: "png",
		stream: false,
	};
}

export function isImageParams(value: unknown): value is OpenAIImageParams {
	return typeof value === "object" && value !== null && "prompt" in value && typeof value.prompt === "string";
}
