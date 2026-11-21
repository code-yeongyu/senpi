import type { Image } from "openai/resources/images.js";
import type { ImageContent } from "../types.ts";
import type { OpenAIImageOutputFormat, OpenAIImagesOptions } from "./openai-images-params.ts";

const MAX_IMAGE_BYTES = 24 * 1024 * 1024;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47] as const;
const JPEG_MAGIC = [0xff, 0xd8, 0xff] as const;
const WEBP_MAGIC = [0x52, 0x49, 0x46, 0x46, 0x57, 0x45, 0x42, 0x50] as const;

type SupportedImageMime = "image/png" | "image/jpeg" | "image/webp";

/** The container the request asked for; a replaced payload without one falls back to the API default. */
export function requestedOutputFormat(value: unknown): OpenAIImageOutputFormat {
	return value === "jpeg" || value === "webp" ? value : "png";
}

/**
 * Decodes one response datum. Inline base64 is labeled by its magic bytes, falling back to
 * the requested container only when the header is unrecognizable: gateways can ignore
 * `output_format` and return png, and a wrong label would follow the file to disk.
 */
export async function resolveImage(
	datum: Image,
	outputFormat: OpenAIImageOutputFormat,
	options?: OpenAIImagesOptions,
): Promise<ImageContent> {
	const b64 = datum.b64_json?.trim();
	if (b64) {
		const detected = detectMime(Buffer.from(b64.slice(0, 24), "base64"));
		return { type: "image", mimeType: detected ?? `image/${outputFormat}`, data: b64 };
	}
	const url = datum.url?.trim();
	if (!url) throw new Error("OpenAI images response datum contained no image data");
	if (url.startsWith("data:")) return parseDataUrl(url);
	return hydrateImageUrl(url, options);
}

function parseDataUrl(url: string): ImageContent {
	const match = /^data:([^;,]+);base64,(.+)$/i.exec(url);
	if (!match?.[1] || !match[2]) throw new Error("OpenAI images response contained an invalid data URL");
	const mimeType = supportedMime(match[1]);
	if (!mimeType) throw new Error(`OpenAI images response used unsupported MIME type: ${match[1]}`);
	return { type: "image", mimeType, data: match[2] };
}

async function hydrateImageUrl(url: string, options?: OpenAIImagesOptions): Promise<ImageContent> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error("OpenAI images response URL must be absolute");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("OpenAI images response URL must use HTTP or HTTPS");
	}
	const response = await (options?.fetch ?? globalThis.fetch)(url, options?.signal ? { signal: options.signal } : {});
	if (!response.ok) throw new Error(`OpenAI image hydration failed with HTTP ${response.status}`);
	const declaredLength = response.headers.get("content-length");
	if (declaredLength && Number(declaredLength) > MAX_IMAGE_BYTES) throw oversizedImageError();
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength === 0) throw new Error("OpenAI image hydration returned an empty body");
	if (bytes.byteLength > MAX_IMAGE_BYTES) throw oversizedImageError();
	const declaredMime = supportedMime(response.headers.get("content-type")?.split(";", 1)[0]);
	const detectedMime = detectMime(bytes);
	if (declaredMime && detectedMime && declaredMime !== detectedMime) {
		throw new Error(`OpenAI image MIME mismatch: declared ${declaredMime}, detected ${detectedMime}`);
	}
	const mimeType = detectedMime ?? declaredMime;
	if (!mimeType) throw new Error("OpenAI image hydration returned unsupported image content");
	return { type: "image", mimeType, data: bytesToBase64(bytes) };
}

function supportedMime(value: string | undefined): SupportedImageMime | undefined {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "image/png" || normalized === "image/jpeg" || normalized === "image/webp") return normalized;
	return undefined;
}

function detectMime(bytes: Uint8Array): SupportedImageMime | undefined {
	if (hasMagic(bytes, PNG_MAGIC)) return "image/png";
	if (hasMagic(bytes, JPEG_MAGIC)) return "image/jpeg";
	if (hasMagic(bytes, WEBP_MAGIC.slice(0, 4)) && hasMagic(bytes, WEBP_MAGIC.slice(4), 8)) return "image/webp";
	return undefined;
}

function hasMagic(bytes: Uint8Array, magic: readonly number[], offset = 0): boolean {
	return magic.every((value, index) => bytes[offset + index] === value);
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	}
	return btoa(binary);
}

function oversizedImageError(): Error {
	return new Error("OpenAI image hydration exceeded the 24 MiB limit");
}
