import { elidedImageIds, imageContentId } from "../../../image-elision-placeholder.ts";

type HashedContent = string | readonly unknown[];

function imageIdsOf(block: unknown): readonly string[] | undefined {
	if (typeof block !== "object" || block === null || !("type" in block)) return undefined;
	if (block.type === "image" && "data" in block && typeof block.data === "string") return [imageContentId(block.data)];
	if (block.type === "text" && "text" in block && typeof block.text === "string") return elidedImageIds(block.text);
	return undefined;
}

/**
 * The transport image budget (`elideOldImages`) swaps older images for placeholders as later images
 * arrive (#2768). The resident SDK session already holds every image it was sent, so the swap changes
 * nothing it receives, and hashing it would read as `sent_stream_diverged` and re-send the conversation.
 * Each image and each placeholder therefore digests as the ids of the images it carries or stands for:
 * an elided image hashes like the image itself, while a different or missing image still diverges.
 */
export function imageNeutralContent(content: HashedContent): HashedContent {
	if (typeof content === "string" || !content.some((block) => imageIdsOf(block) !== undefined)) return content;
	const normalized: unknown[] = [];
	for (const block of content) {
		const ids = imageIdsOf(block);
		if (ids === undefined) normalized.push(block);
		else for (const id of ids) normalized.push({ type: "image", id });
	}
	return normalized;
}
