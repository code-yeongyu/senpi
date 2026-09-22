import type { Base64ImageSource, ContentBlockParam } from "./sdk-boundary.ts";

const IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;

export function appendSdkContentBlocks(blocks: ContentBlockParam[], content: string | readonly unknown[]): boolean {
	if (typeof content === "string") {
		if (content.length > 0) blocks.push({ type: "text", text: content });
		return content.trim().length > 0;
	}

	let hasText = false;
	for (const entry of content) {
		hasText = appendEntry(blocks, entry) || hasText;
	}
	return hasText;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseImageMediaType(value: string): Base64ImageSource["media_type"] | undefined {
	for (const mediaType of IMAGE_MEDIA_TYPES) {
		if (mediaType === value) return mediaType;
	}
	return undefined;
}

function omittedPlaceholder(entry: unknown): string {
	if (isRecord(entry) && typeof entry.type === "string") {
		if (entry.type === "image") {
			const complete = typeof entry.mimeType === "string" && typeof entry.data === "string";
			return complete
				? `[image block omitted: unsupported media type ${entry.mimeType}]`
				: "[image block omitted: missing data]";
		}
		return `[unsupported content block omitted: ${entry.type}]`;
	}
	return "[unsupported content block omitted]";
}

function imageFromEntry(entry: Record<string, unknown>): ContentBlockParam | undefined {
	if (typeof entry.mimeType !== "string" || typeof entry.data !== "string") return undefined;
	const mediaType = parseImageMediaType(entry.mimeType);
	if (mediaType === undefined) return undefined;
	return {
		type: "image",
		source: {
			type: "base64",
			media_type: mediaType,
			data: entry.data,
		},
	};
}

function appendEntry(blocks: ContentBlockParam[], entry: unknown): boolean {
	if (typeof entry === "string") {
		blocks.push({ type: "text", text: entry });
		return entry.trim().length > 0;
	}

	if (!isRecord(entry)) {
		blocks.push({ type: "text", text: omittedPlaceholder(entry) });
		return true;
	}

	if (entry.type === "text") {
		if (typeof entry.text === "string") {
			blocks.push({ type: "text", text: entry.text });
			return entry.text.trim().length > 0;
		}
		blocks.push({ type: "text", text: omittedPlaceholder(entry) });
		return true;
	}

	if (entry.type === "image") {
		const image = imageFromEntry(entry);
		if (image) {
			blocks.push(image);
			return false;
		}
		blocks.push({ type: "text", text: omittedPlaceholder(entry) });
		return true;
	}

	blocks.push({ type: "text", text: omittedPlaceholder(entry) });
	return true;
}
