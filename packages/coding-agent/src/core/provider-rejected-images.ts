/**
 * Provider image rejections (senpi#2170). A provider that rejects an image
 * rejects every later request that replays it, and `dropFailedAssistantTurns`
 * removes the failed turn but not the image, so one bad image bricked the
 * session. The failed assistant turn is persisted with its error, so the
 * rejection is derived from history on every request (and after a restart):
 * images no successful response had accepted before an image-rejection failure
 * are replaced by a placeholder naming their source.
 */

const PROVIDER_IMAGE_REJECTION_PATTERN =
	/does not represent a valid image|image_parse_error|invalid_image|unsupported image|could not process image|unable to process input image|image_url'?\.?[^\n]*invalid base64|expected a base64-encoded data url|image was specified using the image\/[a-z]+ media type|unsupported media type for base64 image|invalid data url for image/i;

interface TurnBlock {
	type: string;
	id?: unknown;
	arguments?: unknown;
}

interface TurnMessage {
	role: string;
}

interface RejectedImage {
	messageIndex: number;
	blockIndex: number;
	source: string;
}

export function isProviderImageRejection(errorMessage: string | undefined): boolean {
	return errorMessage !== undefined && PROVIDER_IMAGE_REJECTION_PATTERN.test(errorMessage);
}

export function rejectedImagePlaceholder(source: string): string {
	return `[Image omitted: the provider rejected this image (${source}) as invalid, so it is no longer sent with the conversation.]`;
}

function field(message: TurnMessage, key: string): unknown {
	return key in message ? (message as unknown as Record<string, unknown>)[key] : undefined;
}

function contentBlocks(message: TurnMessage): readonly TurnBlock[] {
	const content = field(message, "content");
	return Array.isArray(content) ? (content as TurnBlock[]) : [];
}

function toolCallSource(block: TurnBlock): string | undefined {
	const args = block.arguments;
	if (typeof args !== "object" || args === null) return undefined;
	const record = args as Record<string, unknown>;
	for (const key of ["path", "file_path", "filePath"]) {
		const value = record[key];
		if (typeof value === "string" && value.trim().length > 0) return value;
	}
	return undefined;
}

function imageSource(message: TurnMessage, toolCallSources: ReadonlyMap<string, string>): string {
	if (message.role !== "toolResult") return "an attached image";
	const toolCallId = field(message, "toolCallId");
	const known = typeof toolCallId === "string" ? toolCallSources.get(toolCallId) : undefined;
	if (known) return known;
	const toolName = field(message, "toolName");
	return typeof toolName === "string" ? `${toolName} tool result` : "a tool result";
}

/** Rejected images keyed by the index of the failed assistant turn that rejected them. */
function scanRejectedImages(messages: readonly TurnMessage[]): Map<number, RejectedImage[]> {
	const toolCallSources = new Map<string, string>();
	const rejections = new Map<number, RejectedImage[]>();
	let unconfirmed: RejectedImage[] = [];
	messages.forEach((message, messageIndex) => {
		if (message.role === "assistant") {
			for (const block of contentBlocks(message)) {
				const source = block.type === "toolCall" ? toolCallSource(block) : undefined;
				if (source && typeof block.id === "string") toolCallSources.set(block.id, source);
			}
			const stopReason = field(message, "stopReason");
			const errorMessage = field(message, "errorMessage");
			if (
				stopReason === "error" &&
				isProviderImageRejection(typeof errorMessage === "string" ? errorMessage : undefined)
			) {
				if (unconfirmed.length > 0) rejections.set(messageIndex, unconfirmed);
				unconfirmed = [];
			} else if (stopReason !== "error" && stopReason !== "aborted") {
				unconfirmed = [];
			}
			return;
		}
		if (message.role !== "user" && message.role !== "toolResult") return;
		contentBlocks(message).forEach((block, blockIndex) => {
			if (block.type === "image") {
				unconfirmed.push({ messageIndex, blockIndex, source: imageSource(message, toolCallSources) });
			}
		});
	});
	return rejections;
}

export function rejectedImageSources(messages: readonly TurnMessage[], failedTurn: TurnMessage): string[] {
	const failedIndex = messages.lastIndexOf(failedTurn);
	return (scanRejectedImages(messages).get(failedIndex) ?? []).map((image) => image.source);
}

export function omitProviderRejectedImages<T extends TurnMessage>(messages: T[]): T[] {
	const rejected = new Map<number, Map<number, string>>();
	for (const images of scanRejectedImages(messages).values()) {
		for (const image of images) {
			const blocks = rejected.get(image.messageIndex) ?? new Map<number, string>();
			blocks.set(image.blockIndex, image.source);
			rejected.set(image.messageIndex, blocks);
		}
	}
	if (rejected.size === 0) return messages;
	return messages.map((message, messageIndex) => {
		const blocks = rejected.get(messageIndex);
		if (!blocks) return message;
		const content = contentBlocks(message).map((block, blockIndex) => {
			const source = blocks.get(blockIndex);
			return source === undefined ? block : { type: "text", text: rejectedImagePlaceholder(source) };
		});
		return { ...message, content } as T;
	});
}
