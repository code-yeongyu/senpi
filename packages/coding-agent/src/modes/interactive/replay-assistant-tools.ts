import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Component } from "@earendil-works/pi-tui";
import { abortedMessageForRendering } from "./aborted-error-label.ts";
import type { ToolExecutionComponent } from "./components/tool-execution.ts";

type ReplayToolHost = {
	readonly expanded: boolean;
	readonly addMessage: (message: AssistantMessage) => void;
	readonly addChild: (component: Component) => void;
	readonly createTool: (name: string, id: string, args: unknown) => ToolExecutionComponent;
	readonly pending: Map<string, ToolExecutionComponent>;
};

/** Keep text/thinking in its original position, matching the live head and trailing segments. */
export function replayAssistantTools(message: AssistantMessage, host: ReplayToolHost): void {
	const firstToolIndex = message.content.findIndex((block) => block.type === "toolCall");
	host.addMessage(
		firstToolIndex < 0 ? message : { ...message, content: message.content.slice(0, firstToolIndex + 1) },
	);
	if (firstToolIndex < 0) return;
	let index = firstToolIndex;
	while (index < message.content.length) {
		const content = message.content[index];
		if (content.type !== "toolCall") {
			const start = index;
			while (index < message.content.length && message.content[index].type !== "toolCall") index++;
			host.addMessage({ ...message, content: message.content.slice(start, index) });
			continue;
		}
		index++;
		const component = host.createTool(content.name, content.id, content.arguments);
		component.setExpanded(host.expanded);
		host.addChild(component);
		if (message.stopReason === "aborted" || message.stopReason === "error") {
			const errorMessage =
				message.stopReason === "aborted"
					? abortedMessageForRendering(message, 0, undefined).errorMessage || "Provider request failed"
					: message.errorMessage || "Error";
			component.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
		} else {
			host.pending.set(content.id, component);
		}
	}
}
