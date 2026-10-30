import {
	ACCOUNT_LIMIT_NEXT_STEP_LEAD,
	type AssistantMessage,
	SERVER_FALLBACK_ABORTED_DIAGNOSTIC,
	stripTurnRetrySuppressionPrefix,
} from "@earendil-works/pi-ai";
import { usageLimitScope } from "../../../core/retry-fallback/usage-limit.ts";
import { formatDuration } from "../../../utils/duration.ts";
import { formatProviderNativeBody, formatProviderNativeSummary } from "../../provider-native-rendering.ts";
import { describedProviderError } from "../provider-error-description.ts";
import { theme } from "../theme/theme.ts";
import { type HandoffSegment, splitHandoffBlocks } from "./handoff-fold.ts";

type MarkdownDescriptorKind = "text-md" | "thinking-md";
type TextDescriptorKind =
	| "thinking-label"
	| "provider-native-summary"
	| "provider-native-body"
	| "error-text"
	| "handoff-line"
	| "handoff-body";
type AssistantRenderDescriptorKind = "spacer" | MarkdownDescriptorKind | TextDescriptorKind;

export type AssistantRenderDescriptor = {
	readonly kind: AssistantRenderDescriptorKind;
	readonly text: string;
	/** Index of the thinking run this label/body belongs to; set only for thinking descriptors. */
	readonly thinkingRun?: number;
	/** Index of the handoff block this fold line/body belongs to; set only for handoff descriptors. */
	readonly handoffBlock?: number;
};

type AssistantRenderDescriptorOptions = {
	readonly expanded: boolean;
	readonly providerErrorOwned?: boolean;
	readonly hiddenThinkingLabel: string;
	readonly hideThinkingBlock: boolean;
	/** Per-run click overrides of `hideThinkingBlock`, keyed by thinking run index. */
	readonly thinkingVisibilityOverrides?: ReadonlyMap<number, boolean>;
	/** Per-block click overrides of `expanded` for handoff folds, keyed by handoff block index. */
	readonly handoffOpenOverrides?: ReadonlyMap<number, boolean>;
	readonly hasToolCalls: boolean;
};

const SPACER_DESCRIPTOR = { kind: "spacer", text: "" } as const satisfies AssistantRenderDescriptor;

function assertNever(value: never): never {
	throw new TypeError(`Unexpected assistant render variant: ${String(value)}`);
}

/**
 * A handoff block folds into one muted line naming Now and Next (senpi#3323); its answer (the `For you` slot, or the GPT outcome and
 * `You need` slot) stays as answer text below it, so the reader sees the answer and nothing is lost. Ctrl+O (expand
 * all) or a click on the line opens the block as written, dimmed.
 */
function pushHandoffDescriptors(
	descriptors: AssistantRenderDescriptor[],
	segment: HandoffSegment,
	handoffBlock: number,
	open: boolean,
): void {
	if (open) {
		descriptors.push(
			{ kind: "handoff-line", text: theme.fg("dim", "\u25BE Handoff"), handoffBlock },
			{ kind: "handoff-body", text: theme.fg("dim", segment.block), handoffBlock },
		);
		return;
	}
	const parts = [
		segment.now === undefined ? undefined : `Now: ${segment.now}`,
		segment.next === undefined ? undefined : `Next: ${segment.next}`,
	].filter((part): part is string => part !== undefined);
	descriptors.push({
		kind: "handoff-line",
		text: theme.fg("dim", ["\u25B8 Handoff", ...parts].join(" \u00B7 ")),
		handoffBlock,
	});
	if (segment.answer !== undefined) descriptors.push(SPACER_DESCRIPTOR, { kind: "text-md", text: segment.answer });
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
	let handoffBlockIndex = 0;
	for (let i = 0; i < message.content.length; i++) {
		const content = message.content[i];
		switch (content.type) {
			case "text": {
				const text = content.text.trim();
				if (!text) break;
				splitHandoffBlocks(text).forEach((segment, at) => {
					if (at > 0) descriptors.push(SPACER_DESCRIPTOR);
					if (segment.kind === "text") {
						descriptors.push({ kind: "text-md", text: segment.text });
						return;
					}
					const handoffBlock = handoffBlockIndex++;
					const open = options.handoffOpenOverrides?.get(handoffBlock) ?? options.expanded;
					pushHandoffDescriptors(descriptors, segment, handoffBlock, open);
				});
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
			if (options.providerErrorOwned) break;
			const abortMessage =
				message.errorMessage && message.errorMessage !== "Request was aborted"
					? stripTurnRetrySuppressionPrefix(message.errorMessage)
					: "Operation aborted";
			addError(abortMessage);
			break;
		}
		case "error": {
			if (options.hasToolCalls) break;
			if (options.providerErrorOwned) break;
			if (message.diagnostics?.some((entry) => entry.type === SERVER_FALLBACK_ABORTED_DIAGNOSTIC)) break;
			// A provider-stream stall or transport drop carries the classifier's own
			// wording so the retry engine can read it; the transcript gets the
			// plain-language version, without the recovery advice a retry still in
			// flight would contradict, and never the internal replay marker.
			const described = describedProviderError(message);
			// Auth resolution is not a public pi-ai subpath. The component test feeds this boundary
			// providerNotConfiguredMessage output so its classifier sentinel cannot drift.
			const commandHint = stripTurnRetrySuppressionPrefix(message.errorMessage ?? "").startsWith(
				"Provider is not configured: ",
			)
				? " Use /login to connect it, or /model to choose another model."
				: usageLimitScope(message) === "account"
					? message.provider === "anthropic"
						? " Use /login to connect Anthropic Subscription, or /model to choose another provider."
						: described?.includes(ACCOUNT_LIMIT_NEXT_STEP_LEAD)
							? ""
							: " Use /model to choose another provider."
					: "";
			addError(
				described === undefined
					? `Error: ${stripTurnRetrySuppressionPrefix(message.errorMessage ?? "") || "Unknown error"}`
					: `${described}${commandHint}`,
			);
			break;
		}
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
