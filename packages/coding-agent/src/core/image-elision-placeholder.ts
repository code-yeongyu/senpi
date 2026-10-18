import { createHash } from "node:crypto";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

export const IMAGE_ELISION_PLACEHOLDER =
	"[Image elided: an older image was removed to keep the request within the provider's size limit. Re-read the source file if you need to view it again.]";

const IMAGE_ID_LENGTH = 12;
const ID_SUFFIX = new RegExp(`^ \\(image ids?: ([0-9a-f]{${IMAGE_ID_LENGTH}}(?:, [0-9a-f]{${IMAGE_ID_LENGTH}})*)\\)$`);

export function imageContentId(data: string): string {
	return createHash("sha256").update(data).digest("hex").slice(0, IMAGE_ID_LENGTH);
}

function elisionPlaceholder(ids: readonly string[]): TextContent {
	const label = ids.length === 1 ? "id" : "ids";
	return { type: "text", text: `${IMAGE_ELISION_PLACEHOLDER} (image ${label}: ${ids.join(", ")})` };
}

export function elidedImageIds(text: string): readonly string[] | undefined {
	if (!text.startsWith(IMAGE_ELISION_PLACEHOLDER)) return undefined;
	const match = ID_SUFFIX.exec(text.slice(IMAGE_ELISION_PLACEHOLDER.length));
	return match?.[1]?.split(", ");
}

/** Placeholder ids let the subscription lane's sent-stream digest match a placeholder to the image it replaced (senpi#2768). */
export function replaceElidedImages(
	content: readonly (TextContent | ImageContent)[],
	isElided: (blockIndex: number) => boolean,
): (TextContent | ImageContent)[] {
	const replaced: (TextContent | ImageContent)[] = [];
	let pending: string[] = [];
	const flush = () => {
		if (pending.length > 0) replaced.push(elisionPlaceholder(pending));
		pending = [];
	};
	content.forEach((block, blockIndex) => {
		if (block.type === "image" && isElided(blockIndex)) {
			pending.push(imageContentId(block.data));
			return;
		}
		flush();
		replaced.push(block);
	});
	flush();
	return replaced;
}
