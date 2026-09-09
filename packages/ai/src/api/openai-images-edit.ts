import { toFile } from "openai";
import type { ImageContent } from "../types.ts";
import type { OpenAIImageParams } from "./openai-images-params.ts";

export async function buildEditParams(params: OpenAIImageParams, images: ImageContent[]): Promise<OpenAIImageParams> {
	if (images.length > 16) throw new Error("OpenAI image edits accept at most 16 reference images");
	const image = await Promise.all(
		images.map(({ data, mimeType }, i) => {
			const ext = mimeType.split("/")[1];
			return toFile(Buffer.from(data, "base64"), `reference-${i}.${ext}`, { type: mimeType });
		}),
	);
	return { ...params, image };
}
