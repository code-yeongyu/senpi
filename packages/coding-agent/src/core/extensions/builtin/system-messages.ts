import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { CustomMessage } from "../../messages.js";
import type { ExtensionAPI } from "../types.js";

export const SENPI_SYSTEM_PREFIX = "[system:senpi]";
export const SENPI_CONVERSATION_EVENT = "senpi:conversation";

export type BuiltinSystemMessageRoute = "todotools.continuation";
export type SenpiConversationAction = "injected" | "failed";

export interface SenpiConversationEvent {
	version: 1;
	source: "builtin";
	action: SenpiConversationAction;
	route: BuiltinSystemMessageRoute;
	sessionId?: string;
	timestamp: number;
	conversation: {
		prefix: typeof SENPI_SYSTEM_PREFIX;
		kind: "custom_message" | "user_message";
		customType?: string;
		deliverAs?: "steer" | "followUp";
		triggerTurn?: boolean;
	};
	text: string;
	errorMessage?: string;
}

type BuiltinUserMessageOptions = {
	deliverAs?: "steer" | "followUp";
	sessionId?: string;
};

type BuiltinCustomMessageOptions = {
	triggerTurn?: boolean;
	deliverAs?: "steer" | "followUp" | "nextTurn";
	sessionId?: string;
};

function prefixText(text: string): string {
	return text.startsWith(SENPI_SYSTEM_PREFIX) ? text : `${SENPI_SYSTEM_PREFIX}\n${text}`;
}

function prefixContent(content: string | (TextContent | ImageContent)[]): string | (TextContent | ImageContent)[] {
	if (typeof content === "string") {
		return prefixText(content);
	}

	const firstTextIndex = content.findIndex((part) => part.type === "text");
	if (firstTextIndex === -1) {
		return [{ type: "text", text: SENPI_SYSTEM_PREFIX }, ...content];
	}

	return content.map((part, index) => {
		if (part.type !== "text" || index !== firstTextIndex) {
			return part;
		}

		return {
			...part,
			text: prefixText(part.text),
		};
	});
}

function extractText(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") {
		return content;
	}

	return content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function emitSenpiConversationEvent(pi: ExtensionAPI, event: SenpiConversationEvent): void {
	pi.events.emit(SENPI_CONVERSATION_EVENT, event);
}

function createBaseEvent(args: {
	action: SenpiConversationAction;
	route: BuiltinSystemMessageRoute;
	sessionId?: string;
	kind: "custom_message" | "user_message";
	customType?: string;
	deliverAs?: "steer" | "followUp";
	triggerTurn?: boolean;
	text: string;
	errorMessage?: string;
}): SenpiConversationEvent {
	return {
		version: 1,
		source: "builtin",
		action: args.action,
		route: args.route,
		sessionId: args.sessionId,
		timestamp: Date.now(),
		conversation: {
			prefix: SENPI_SYSTEM_PREFIX,
			kind: args.kind,
			customType: args.customType,
			deliverAs: args.deliverAs,
			triggerTurn: args.triggerTurn,
		},
		text: args.text,
		errorMessage: args.errorMessage,
	};
}

function hasUserMessageOptions(
	options: BuiltinUserMessageOptions | undefined,
): options is BuiltinUserMessageOptions & { deliverAs: "steer" | "followUp" } {
	return options?.deliverAs !== undefined;
}

function hasCustomMessageOptions(
	options: BuiltinCustomMessageOptions | undefined,
): options is BuiltinCustomMessageOptions & { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" } {
	return options?.triggerTurn === true || options?.deliverAs !== undefined;
}

export function sendBuiltinUserMessage(
	pi: ExtensionAPI,
	route: BuiltinSystemMessageRoute,
	content: string | (TextContent | ImageContent)[],
	options?: BuiltinUserMessageOptions,
): void {
	const prefixedContent = prefixContent(content);

	emitSenpiConversationEvent(
		pi,
		createBaseEvent({
			action: "injected",
			route,
			sessionId: options?.sessionId,
			kind: "user_message",
			text: extractText(prefixedContent),
			deliverAs: options?.deliverAs,
		}),
	);

	if (hasUserMessageOptions(options)) {
		pi.sendUserMessage(prefixedContent, { deliverAs: options.deliverAs });
		return;
	}

	pi.sendUserMessage(prefixedContent);
}

export function sendBuiltinCustomMessage<TDetails>(
	pi: ExtensionAPI,
	route: BuiltinSystemMessageRoute,
	message: Pick<CustomMessage<TDetails>, "content" | "customType" | "details" | "display">,
	options?: BuiltinCustomMessageOptions,
): void {
	const prefixedContent = prefixContent(message.content);
	const deliverAs = options?.deliverAs === "nextTurn" ? undefined : options?.deliverAs;

	emitSenpiConversationEvent(
		pi,
		createBaseEvent({
			action: "injected",
			route,
			sessionId: options?.sessionId,
			kind: "custom_message",
			customType: message.customType,
			text: extractText(prefixedContent),
			deliverAs,
			triggerTurn: options?.triggerTurn,
		}),
	);

	const prefixedMessage = {
		...message,
		content: prefixedContent,
	};

	if (hasCustomMessageOptions(options)) {
		pi.sendMessage(prefixedMessage, {
			triggerTurn: options.triggerTurn,
			deliverAs: options.deliverAs,
		});
		return;
	}

	pi.sendMessage(prefixedMessage);
}

export function emitBuiltinSystemMessageFailure(
	pi: ExtensionAPI,
	args: {
		route: BuiltinSystemMessageRoute;
		sessionId?: string;
		kind: "custom_message" | "user_message";
		content: string | (TextContent | ImageContent)[];
		customType?: string;
		deliverAs?: "steer" | "followUp";
		triggerTurn?: boolean;
		errorMessage: string;
	},
): void {
	const prefixedContent = prefixContent(args.content);

	emitSenpiConversationEvent(
		pi,
		createBaseEvent({
			action: "failed",
			route: args.route,
			sessionId: args.sessionId,
			kind: args.kind,
			customType: args.customType,
			text: extractText(prefixedContent),
			deliverAs: args.deliverAs,
			triggerTurn: args.triggerTurn,
			errorMessage: args.errorMessage,
		}),
	);
}
