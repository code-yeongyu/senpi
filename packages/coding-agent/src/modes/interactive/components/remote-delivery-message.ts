import type { TextContent } from "@earendil-works/pi-ai";
import { Box, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import {
	isSessionControlDeliveryDetails,
	type MessageRenderer,
	SESSION_CONTROL_DELIVERY_TYPE,
	type SessionControlSender,
	sessionControlSenderOf,
} from "../../../core/extensions/types.ts";
import { getMarkdownTheme } from "../theme/theme.ts";

/**
 * A message another session delivered renders as its own block - never as the user's own input, so
 * a reader always sees which text came from outside this terminal. A delivery that names its sender
 * shows one label line ("Sent by another agent · <name>") over the message as it was written; one
 * that does not keeps the generic heading over the text the model read.
 */
export const renderRemoteDelivery: MessageRenderer = (message, _options, theme) => {
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	const sender = sessionControlSenderOf(message.details);
	const shown = sender === undefined ? undefined : displayTextOf(message.details);
	if (sender !== undefined && shown !== undefined) {
		box.addChild(new Text(theme.fg("dim", senderLabel(sender)), 0, 0));
		box.addChild(new Spacer(1));
		box.addChild(
			new Markdown(shown, 0, 0, getMarkdownTheme(), { color: (line) => theme.fg("customMessageText", line) }),
		);
		return box;
	}
	const label = theme.fg("customMessageLabel", theme.bold("remote message"));
	box.addChild(new Text(`${label}${theme.fg("dim", ` · delivery ${deliveryIdOf(message.details)}`)}`, 0, 0));
	box.addChild(new Spacer(1));
	const text =
		typeof message.content === "string"
			? message.content
			: message.content
					.filter((part): part is TextContent => part.type === "text")
					.map((part) => part.text)
					.join("\n");
	box.addChild(new Markdown(text, 0, 0, getMarkdownTheme(), { color: (line) => theme.fg("customMessageText", line) }));
	return box;
};

export function senderLabel(sender: SessionControlSender): string {
	switch (sender.kind) {
		case "agent":
			return sender.name === undefined || sender.name.trim() === ""
				? "Sent by another agent"
				: `Sent by another agent · ${sender.name}`;
		case "command_line":
			return "Sent from the command line";
		case "external":
			return sender.author === undefined || sender.author.trim() === ""
				? `Sent from ${sender.platform}`
				: `Sent from ${sender.platform} · ${sender.author}`;
	}
}

export function builtInMessageRenderer(customType: string): MessageRenderer | undefined {
	return customType === SESSION_CONTROL_DELIVERY_TYPE ? renderRemoteDelivery : undefined;
}

function displayTextOf(details: unknown): string | undefined {
	return isSessionControlDeliveryDetails(details) && typeof details.display_text === "string"
		? details.display_text
		: undefined;
}

function deliveryIdOf(details: unknown): string {
	if (typeof details !== "object" || details === null || !("delivery_id" in details)) return "unknown";
	return typeof details.delivery_id === "string" ? details.delivery_id : "unknown";
}
