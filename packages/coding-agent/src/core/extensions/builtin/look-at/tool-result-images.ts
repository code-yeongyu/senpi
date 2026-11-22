import { type ImageContent, isVideoMimeType, type TextContent } from "@earendil-works/pi-ai";
import { buildImageDescriptionBlock } from "./prompts.ts";

/** Every description is a request to the vision model, so a result with more images keeps the rest. */
const MAX_DESCRIBED_IMAGES_PER_RESULT = 3;

type ToolResultContent = (TextContent | ImageContent)[];

export interface ImageDescription {
	/** `provider/id` of the vision model that wrote the description. */
	model: string;
	text: string;
}

export interface DescribedToolResult {
	/** The content with each described image replaced by its description; undefined when none was described. */
	content: ToolResultContent | undefined;
	/** Why each failed description failed. Its image stays where it was. */
	failures: string[];
}

export async function describeToolResultImages(
	content: ToolResultContent,
	toolName: string,
	describe: (image: ImageContent) => Promise<ImageDescription>,
): Promise<DescribedToolResult> {
	const images = content
		.filter((block): block is ImageContent => block.type === "image" && !isVideoMimeType(block.mimeType))
		.slice(0, MAX_DESCRIBED_IMAGES_PER_RESULT);
	const outcomes = await Promise.allSettled(images.map(describe));
	const descriptions = new Map<ImageContent, ImageDescription>();
	const failures: string[] = [];
	outcomes.forEach((outcome, index) => {
		if (outcome.status === "fulfilled") descriptions.set(images[index], outcome.value);
		else failures.push(outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason));
	});
	if (descriptions.size === 0) return { content: undefined, failures };

	return {
		content: content.map((block) => {
			const description = block.type === "image" ? descriptions.get(block) : undefined;
			if (!description) return block;
			return {
				type: "text" as const,
				text: buildImageDescriptionBlock(description.model, toolName, description.text),
			};
		}),
		failures,
	};
}
