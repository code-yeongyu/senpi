import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AssistantImages } from "@earendil-works/pi-ai/compat";

export interface GeneratedImage {
	data: string;
	mimeType: string;
	revisedPrompt?: string;
}

export function collectImages(images: AssistantImages): GeneratedImage[] {
	const collected: GeneratedImage[] = [];
	let pendingText: string | undefined;
	for (const block of images.output) {
		if (block.type === "text") {
			const text = block.text.trim();
			pendingText = text.length > 0 ? text : undefined;
			continue;
		}
		collected.push({
			data: block.data,
			mimeType: block.mimeType,
			...(pendingText === undefined ? {} : { revisedPrompt: pendingText }),
		});
		pendingText = undefined;
	}
	return collected;
}

export async function writeImages(paths: string[], images: GeneratedImage[]): Promise<string | undefined> {
	const written: string[] = [];
	for (const [index, image] of images.entries()) {
		const target = paths[index];
		if (target === undefined) break;
		try {
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, Buffer.from(image.data, "base64"), { flag: "wx" });
			written.push(target);
		} catch (error) {
			for (const path of written) await rm(path, { force: true }).catch(() => undefined);
			const reason = error instanceof Error ? error.message : String(error);
			return `Error: failed to write generated image to ${target}: ${reason}`;
		}
	}
	return undefined;
}
