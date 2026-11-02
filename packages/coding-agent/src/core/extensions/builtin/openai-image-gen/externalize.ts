import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AssistantMessage, ProviderNativeContent, TextContent } from "@earendil-works/pi-ai";
import { displayPath, GENERATED_IMAGE_DIRECTORY, sanitizeImageStem } from "../imagegen/paths.ts";

export const IMAGE_GENERATION_CALL_SUBTYPE = "image_generation_call";
const MAX_COLLISION_ATTEMPTS = 100;

/** The completed shape this pass externalizes. Everything else stays untouched. */
interface CompletedNativeImage {
	id?: string;
	result: string;
	revisedPrompt?: string;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

/**
 * Recognizes a completed native image call carrying a base64 payload. Non-completed
 * and already-scrubbed items return undefined: they carry no bytes to externalize.
 */
export function readCompletedNativeImage(raw: unknown): CompletedNativeImage | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const record: Record<string, unknown> = { ...raw };
	if (readString(record, "type") !== IMAGE_GENERATION_CALL_SUBTYPE) return undefined;
	if (readString(record, "status") !== "completed") return undefined;
	const result = readString(record, "result");
	if (result === undefined || result.length === 0) return undefined;
	const id = readString(record, "id");
	const revisedPrompt = readString(record, "revised_prompt");
	return {
		...(id === undefined ? {} : { id }),
		result,
		...(revisedPrompt?.trim() ? { revisedPrompt } : {}),
	};
}

/**
 * Detects the container from the decoded magic bytes. The Responses API does not
 * contractually pin the encoding of `result`, so an undetectable payload defaults
 * to png rather than being rejected.
 */
export function detectImageExtension(bytes: Buffer): "png" | "jpg" | "webp" {
	if (
		bytes.length >= 8 &&
		bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
	) {
		return "png";
	}
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return "jpg";
	}
	if (
		bytes.length >= 12 &&
		bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
		bytes.subarray(8, 12).toString("ascii") === "WEBP"
	) {
		return "webp";
	}
	return "png";
}

/** Item id when the provider sent one, else `<responseId>-<outputIndex>`. */
function fileStem(image: CompletedNativeImage, responseId: string | undefined, outputIndex: number): string {
	if (image.id !== undefined) return sanitizeImageStem(image.id);
	return sanitizeImageStem(`${responseId ?? "image"}-${outputIndex}`);
}

function decodeBase64(result: string): Buffer {
	const bytes = Buffer.from(result, "base64");
	if (bytes.length === 0) throw new Error("decoded to zero bytes");
	return bytes;
}

/**
 * Writes the image without ever overwriting an existing file: a taken name gains a
 * `-2`, `-3`, ... suffix, so a replayed or duplicated item id never discards a
 * valid earlier image.
 */
async function writeWithoutOverwrite(
	directory: string,
	stem: string,
	extension: string,
	bytes: Buffer,
): Promise<string> {
	await mkdir(directory, { recursive: true });
	for (let attempt = 1; attempt <= MAX_COLLISION_ATTEMPTS; attempt++) {
		const suffix = attempt === 1 ? "" : `-${attempt}`;
		const target = join(directory, `${stem}${suffix}.${extension}`);
		try {
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, bytes, { flag: "wx" });
			return target;
		} catch (error) {
			const code = error instanceof Error && "code" in error ? error.code : undefined;
			if (code !== "EEXIST") throw error;
		}
	}
	throw new Error(`no free filename for ${stem}.${extension}`);
}

function successText(cwd: string, target: string, revisedPrompt: string | undefined): TextContent {
	const lines = [`Generated image: ${displayPath(cwd, target)}`];
	if (revisedPrompt !== undefined) lines.push(`Revised prompt: ${revisedPrompt}`);
	return { type: "text", text: lines.join("\n") };
}

function failureText(reason: string): TextContent {
	return { type: "text", text: `Generated image could not be saved: ${reason}.` };
}

/**
 * Externalizes one completed block. The base64 leaves the transcript whether or not
 * the write succeeds, so a failing disk can never turn into a persisted payload.
 */
async function externalizeBlock(
	cwd: string,
	image: CompletedNativeImage,
	responseId: string | undefined,
	outputIndex: number,
): Promise<TextContent> {
	try {
		const bytes = decodeBase64(image.result);
		const target = await writeWithoutOverwrite(
			join(cwd, GENERATED_IMAGE_DIRECTORY),
			fileStem(image, responseId, outputIndex),
			detectImageExtension(bytes),
			bytes,
		);
		return successText(cwd, target, image.revisedPrompt);
	} catch (error) {
		return failureText(error instanceof Error ? error.message : String(error));
	}
}

function isImageGenerationCall(block: { type: string; subtype?: string }): block is ProviderNativeContent {
	return block.type === "providerNative" && block.subtype === IMAGE_GENERATION_CALL_SUBTYPE;
}

/**
 * Replaces every completed native image block with text pointing at a saved file.
 * Returns undefined when the message carries no image bytes, so unrelated messages
 * pass through by reference.
 */
export async function externalizeNativeImages(
	message: AssistantMessage,
	cwd: string,
): Promise<AssistantMessage | undefined> {
	const content: AssistantMessage["content"] = [];
	let replaced = false;
	for (const [outputIndex, block] of message.content.entries()) {
		const image = isImageGenerationCall(block) ? readCompletedNativeImage(block.raw) : undefined;
		if (image === undefined) {
			content.push(block);
			continue;
		}
		content.push(await externalizeBlock(cwd, image, message.responseId, outputIndex));
		replaced = true;
	}
	return replaced ? { ...message, content } : undefined;
}
