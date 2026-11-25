import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { downgradeUnsupportedImages } from "@earendil-works/pi-ai/api/transform-messages";
import { inheritSessionContextEntryId } from "../../../session-manager.ts";

/**
 * Replace the images `model` cannot take with placeholders that name `toolName`. The provider
 * replaces whatever image is left with a placeholder that names no tool, so this has to run
 * first. Returns the input list when no message carries an image.
 */
export function replaceImagesNamingTool(messages: AgentMessage[], model: Model<Api>, toolName: string): AgentMessage[] {
	let replaced = false;
	const result = messages.map((message) => {
		if (message.role !== "user" && message.role !== "toolResult") return message;
		if (!Array.isArray(message.content) || !message.content.some((block) => block.type === "image")) return message;
		replaced = true;
		const [downgraded] = downgradeUnsupportedImages([message], model, { imageDescriptionTool: toolName });
		return inheritSessionContextEntryId(downgraded, message);
	});
	return replaced ? result : messages;
}
