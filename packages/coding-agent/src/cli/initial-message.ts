import type { ImageContent } from "@earendil-works/pi-ai";
import type { Args } from "./args.ts";

export interface InitialMessageInput {
	parsed: Args;
	fileText?: string;
	fileImages?: ImageContent[];
	stdinContent?: string;
}

export interface InitialMessageResult {
	initialMessage?: string;
	initialImages?: ImageContent[];
	initialTitlePrompt?: string;
}

/**
 * Combine stdin content, @file text, and the first CLI message into a single
 * initial prompt for non-interactive mode.
 */
export function buildInitialMessage({
	parsed,
	fileText,
	fileImages,
	stdinContent,
}: InitialMessageInput): InitialMessageResult {
	const parts: string[] = [];
	if (stdinContent !== undefined) {
		parts.push(stdinContent);
	}
	if (fileText) {
		parts.push(fileText);
	}

	const hasPrivateInitialContext =
		stdinContent !== undefined || fileText !== undefined || (fileImages !== undefined && fileImages.length > 0);
	const titlePrompt = hasPrivateInitialContext ? undefined : parsed.messages[0];
	if (parsed.messages.length > 0) {
		parts.push(parsed.messages[0]);
		parsed.messages.shift();
	}

	return {
		initialMessage: parts.length > 0 ? parts.join("") : undefined,
		initialImages: fileImages && fileImages.length > 0 ? fileImages : undefined,
		initialTitlePrompt: titlePrompt,
	};
}

/** True when a print run has something to send: a prompt, piped stdin, @file content or images, or a later message. */
export function hasPrintInput(initial: InitialMessageResult, laterMessages: readonly string[]): boolean {
	return (
		Boolean(initial.initialMessage) ||
		(initial.initialImages?.length ?? 0) > 0 ||
		laterMessages.some((message) => message.length > 0)
	);
}
