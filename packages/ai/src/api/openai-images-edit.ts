import { toFile } from "openai";
import type { ImageContent } from "../types.ts";
import type { OpenAIImageParams } from "./openai-images-params.ts";

function upload(image: ImageContent, name: string) {
	return toFile(Buffer.from(image.data, "base64"), `${name}.${image.mimeType.split("/")[1]}`, {
		type: image.mimeType,
	});
}

export async function buildEditParams(
	params: OpenAIImageParams,
	images: ImageContent[],
	mask?: ImageContent,
): Promise<OpenAIImageParams> {
	if (images.length > 16) throw new Error("OpenAI image edits accept at most 16 reference images");
	const image = await Promise.all(images.map((reference, i) => upload(reference, `reference-${i}`)));
	if (mask === undefined) return { ...params, image };
	return { ...params, image, mask: await upload(mask, "mask") };
}
