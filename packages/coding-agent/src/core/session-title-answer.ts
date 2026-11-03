import type { AssistantMessage, StopReason, TextContent } from "@earendil-works/pi-ai/compat";

const FALLBACK_TITLE_MAX_CHARS = 48;

export interface SessionTitleNoTextWarning {
	readonly code: "title_model_returned_no_text";
	readonly stopReason: StopReason;
	readonly maxTokens: number;
}

export type SessionTitleOutcome =
	| { readonly kind: "titled"; readonly title: string }
	| { readonly kind: "fallback"; readonly title: string; readonly warning: SessionTitleNoTextWarning }
	| { readonly kind: "untitled" }
	| { readonly kind: "unparsed" };

/**
 * What one title response holds. `no-answer` is a response with no usable text: empty (only reasoning, or
 * nothing) or cut off at the token budget before the `<title>` tag closed.
 */
export type TitleAnswer =
	| { readonly kind: "title"; readonly title: string }
	| { readonly kind: "none" }
	| { readonly kind: "no-answer" }
	| { readonly kind: "unparsed" };

export function readTitleAnswer(message: AssistantMessage): TitleAnswer {
	const text = message.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("")
		.trim();
	const rawTitle = text.match(/<title>\s*([\s\S]*?)\s*<\/title>/i)?.[1];
	if (rawTitle === undefined) {
		return text.length === 0 || message.stopReason === "length" ? { kind: "no-answer" } : { kind: "unparsed" };
	}
	const title = sanitizeTitle(rawTitle);
	if (!title || title.toLowerCase() === "none") {
		return { kind: "none" };
	}
	return { kind: "title", title };
}

export function titleOutcome(
	answer: TitleAnswer,
	firstPrompt: string,
	response: AssistantMessage,
	maxTokens: number,
): SessionTitleOutcome {
	switch (answer.kind) {
		case "title":
			return { kind: "titled", title: answer.title };
		case "none":
			return { kind: "untitled" };
		case "unparsed":
			return { kind: "unparsed" };
		case "no-answer": {
			const title = fallbackSessionTitle(firstPrompt);
			if (title === undefined) return { kind: "untitled" };
			const warning: SessionTitleNoTextWarning = {
				code: "title_model_returned_no_text",
				stopReason: response.stopReason,
				maxTokens,
			};
			return { kind: "fallback", title, warning };
		}
	}
}

/** The first line of the prompt, cut at a word boundary: the same text every time for the same prompt. */
function fallbackSessionTitle(firstPrompt: string): string | undefined {
	const firstLine = firstPrompt
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	if (firstLine === undefined) return undefined;
	const line = sanitizeTitle(firstLine);
	if (line.length <= FALLBACK_TITLE_MAX_CHARS) return line || undefined;
	const head = line.slice(0, FALLBACK_TITLE_MAX_CHARS + 1);
	const boundary = head.lastIndexOf(" ");
	const cut = boundary > 0 ? head.slice(0, boundary) : line.slice(0, FALLBACK_TITLE_MAX_CHARS);
	return cut.replace(/[\s,;:-]+$/, "") || undefined;
}

function sanitizeTitle(text: string): string {
	return text
		.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\u001b[\u0020-\u002f]*[\u0030-\u007e]/g, "")
		.replace(/[\r\n]+/g, " ")
		.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
		.replace(/\s+/g, " ")
		.replace(/^["'`]+|["'`.!?]+$/g, "")
		.trim()
		.slice(0, 80)
		.trim();
}
