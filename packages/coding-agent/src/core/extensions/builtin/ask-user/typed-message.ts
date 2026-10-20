import type { ImageContent } from "@earendil-works/pi-ai";
import type { QuestionResponse } from "./schema.ts";

/**
 * A regular message the user submits while a blocking question waits is that question's answer
 * (senpi#3774). The settlement is a `comment-submitted` response with `resolvedBy: "typed_message"`,
 * so clients that only know the existing outcome vocabulary keep decoding it.
 */
export const TYPED_MESSAGE = "typed_message";

export const IMAGE_ONLY_ANSWER = "(The user answered with the attached image.)";

/**
 * The abort reason a question UI receives when the typed message settled the question: the UI did
 * not answer, so it must report the extension's response rather than a dismissal.
 */
export class QuestionAnsweredByMessage {
	readonly response: QuestionResponse;
	constructor(response: QuestionResponse) {
		this.response = response;
	}
}

export const typedMessageImages = new WeakMap<QuestionResponse, ImageContent[]>();
