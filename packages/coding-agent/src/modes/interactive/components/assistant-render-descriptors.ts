import { type AssistantMessage, SERVER_FALLBACK_ABORTED_DIAGNOSTIC } from "@earendil-works/pi-ai";
import { formatDuration } from "../../../utils/duration.ts";
import { formatProviderNativeBody, formatProviderNativeSummary } from "../../provider-native-rendering.ts";
import { theme } from "../theme/theme.ts";

type MarkdownDescriptorKind = "text-md" | "thinking-md";
type TextDescriptorKind = "thinking-label" | "provider-native-summary" | "provider-native-body" | "error-text";
type AssistantRenderDescriptorKind = "spacer" | MarkdownDescriptorKind | TextDescriptorKind;

export type AssistantRenderDescriptor = {
	readonly kind: AssistantRenderDescriptorKind;
	readonly text: string;
	/** Index of the thinking run this label/body belongs to; set only for thinking descriptors. */
	readonly thinkingRun?: number;
};

type AssistantRenderDescriptorOptions = {
	readonly expanded: boolean;
	readonly hiddenThinkingLabel: string;
	readonly hideThinkingBlock: boolean;
	/** Per-run click overrides of `hideThinkingBlock`, keyed by thinking run index. */
	readonly thinkingVisibilityOverrides?: ReadonlyMap<number, boolean>;
	readonly hasToolCalls: boolean;
};

const SPACER_DESCRIPTOR = { kind: "spacer", text: "" } as const satisfies AssistantRenderDescriptor;

function assertNever(value: never): never {
	throw new TypeError(`Unexpected assistant render variant: ${String(value)}`);
}

function isVisibleContent(content: AssistantMessage["content"][number], providerNativeVisible: boolean): boolean {
	switch (content.type) {
		case "text":
			return Boolean(content.text.trim());
		case "thinking":
			return Boolean(content.thinking.trim());
		case "providerNative":
			return providerNativeVisible;
		case "toolCall":
			return false;
		default:
			return assertNever(content);
	}
}

export function createAssistantRenderDescriptors(
	message: AssistantMessage,
	options: AssistantRenderDescriptorOptions,
): readonly AssistantRenderDescriptor[] {
	const descriptors: AssistantRenderDescriptor[] = [];
	if (message.content.some((content) => isVisibleContent(content, true))) descriptors.push(SPACER_DESCRIPTOR);
	let thinkingRunIndex = 0;
	for (let i = 0; i < message.content.length; i++) {
		const content = message.content[i];
		switch (content.type) {
			case "text": {
				const text = content.text.trim();
				if (text) descriptors.push({ kind: "text-md", text });
				break;
			}
			case "thinking": {
				const thinkingBlocks: string[] = [];
				let hasTiming = false;
				let isDone = true;
				let minStart = Number.POSITIVE_INFINITY;
				let maxEnd = Number.NEGATIVE_INFINITY;
				for (; i < message.content.length; i++) {
					const thinkingContent = message.content[i];
					if (thinkingContent.type !== "thinking") break;
					const startedAt = thinkingContent.startedAt;
					if (startedAt !== undefined) {
						hasTiming = true;
						minStart = Math.min(minStart, startedAt);
						const endedAt = thinkingContent.endedAt;
						if (endedAt === undefined) {
							isDone = false;
						} else {
							maxEnd = Math.max(maxEnd, endedAt);
						}
					}
					const thinking = thinkingContent.thinking.trim();
					if (thinking) thinkingBlocks.push(thinking);
				}
				i--;
				if (thinkingBlocks.length === 0) break;
				const thinkingRun = thinkingRunIndex++;
				const hidden = options.thinkingVisibilityOverrides?.get(thinkingRun) ?? options.hideThinkingBlock;
				if (!hasTiming) {
					const text = hidden
						? theme.italic(theme.fg("thinkingText", options.hiddenThinkingLabel))
						: thinkingBlocks.join("\n\n");
					descriptors.push({ kind: hidden ? "thinking-label" : "thinking-md", text, thinkingRun });
				} else {
					const label = isDone
						? theme.italic(theme.fg("thinkingText", `Thought: ${formatDuration(Math.max(0, maxEnd - minStart))}`))
						: theme.italic(theme.fg("thinkingText", options.hiddenThinkingLabel));
					if (hidden) {
						descriptors.push({ kind: "thinking-label", text: label, thinkingRun });
					} else {
						descriptors.push(
							{ kind: "thinking-label", text: label, thinkingRun },
							{ kind: "thinking-md", text: thinkingBlocks.join("\n\n"), thinkingRun },
						);
					}
				}
				if (message.content.slice(i + 1).some((following) => isVisibleContent(following, false)))
					descriptors.push(SPACER_DESCRIPTOR);
				break;
			}
			case "providerNative":
				descriptors.push(
					{
						kind: "provider-native-summary",
						text: theme.fg("muted", formatProviderNativeSummary(message, content, options.expanded)),
					},
					{
						kind: "provider-native-body",
						text: theme.fg("dim", formatProviderNativeBody(content, options.expanded)),
					},
				);
				if (message.content.slice(i + 1).some((following) => isVisibleContent(following, true)))
					descriptors.push(SPACER_DESCRIPTOR);
				break;
			case "toolCall":
				break;
			default:
				assertNever(content);
		}
	}
	const addError = (text: string): void => {
		descriptors.push(SPACER_DESCRIPTOR, { kind: "error-text", text: theme.fg("error", text) });
	};
	switch (message.stopReason) {
		case "length":
			addError(
				"Error: Model stopped because it reached the maximum output token limit. The response may be incomplete.",
			);
			break;
		case "aborted": {
			if (options.hasToolCalls) break;
			const abortMessage =
				message.errorMessage && message.errorMessage !== "Request was aborted"
					? message.errorMessage
					: "Operation aborted";
			addError(abortMessage);
			break;
		}
		case "error":
			if (
				!options.hasToolCalls &&
				!message.diagnostics?.some((entry) => entry.type === SERVER_FALLBACK_ABORTED_DIAGNOSTIC)
			)
				addError(`Error: ${message.errorMessage || "Unknown error"}`);
			break;
		case "pending":
		case "stop":
		case "toolUse":
		case "deferred":
			break;
		default:
			assertNever(message.stopReason);
	}
	return descriptors;
}
