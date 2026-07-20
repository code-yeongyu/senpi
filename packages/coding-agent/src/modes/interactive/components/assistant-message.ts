import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type Component, Container, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import { formatProviderNativeBody, formatProviderNativeSummary } from "../../provider-native-rendering.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createBoundedRenderSignature } from "./render-signature.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

type MarkdownDescriptorKind = "text-md" | "thinking-md";
type TextDescriptorKind = "thinking-label" | "provider-native-summary" | "provider-native-body" | "error-text";
type RenderDescriptorKind = "spacer" | MarkdownDescriptorKind | TextDescriptorKind;
type RenderDescriptor = { readonly kind: RenderDescriptorKind; readonly text: string };

const SPACER_DESCRIPTOR = { kind: "spacer", text: "" } as const satisfies RenderDescriptor;

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

export class AssistantMessageComponent extends Container {
	private renderCache?: { readonly lines: string[]; readonly signature: string; readonly width: number };
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private lastMessage?: AssistantMessage;
	private lastMessageSignature?: string;
	private renderDescriptors: readonly RenderDescriptor[] = [];
	private hasToolCalls = false;
	private expanded = false;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) this.updateContent(message);
	}

	override invalidate(): void {
		this.renderCache = undefined;
		super.invalidate();
		this.renderDescriptors = [];
		this.refreshContent();
	}

	setHideThinkingBlock(hide: boolean): void {
		if (this.hideThinkingBlock === hide) return;
		this.hideThinkingBlock = hide;
		this.refreshContent();
	}

	setHiddenThinkingLabel(label: string): void {
		if (this.hiddenThinkingLabel === label) return;
		this.hiddenThinkingLabel = label;
		this.refreshContent();
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.refreshContent();
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		this.renderDescriptors = [];
		this.refreshContent();
	}

	override render(width: number): string[] {
		const signature = this.lastMessageSignature ?? "";
		if (this.renderCache?.width === width && this.renderCache.signature === signature) {
			return [...this.renderCache.lines];
		}

		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			this.cacheRender(width, signature, lines);
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		this.cacheRender(width, signature, lines);
		return lines;
	}

	updateContent(message: AssistantMessage): void {
		const previousMessage = this.lastMessage;
		this.lastMessage = message;
		const messageSignature = this.createMessageSignature(message);
		if (previousMessage === message && this.lastMessageSignature === messageSignature) {
			return;
		}
		this.lastMessageSignature = messageSignature;
		this.renderCache = undefined;
		this.hasToolCalls = message.content.some((content) => content.type === "toolCall");
		const descriptors = this.createRenderDescriptors(message);
		this.reconcileRenderDescriptors(descriptors);
	}

	private createRenderDescriptors(message: AssistantMessage): readonly RenderDescriptor[] {
		const descriptors: RenderDescriptor[] = [];
		if (message.content.some((content) => isVisibleContent(content, true))) descriptors.push(SPACER_DESCRIPTOR);
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
					for (; i < message.content.length; i++) {
						const thinkingContent = message.content[i];
						if (thinkingContent.type !== "thinking") break;
						const thinking = thinkingContent.thinking.trim();
						if (thinking) thinkingBlocks.push(thinking);
					}
					i--;
					if (thinkingBlocks.length === 0) break;
					const text = this.hideThinkingBlock
						? theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel))
						: thinkingBlocks.join("\n\n");
					descriptors.push({ kind: this.hideThinkingBlock ? "thinking-label" : "thinking-md", text });
					if (message.content.slice(i + 1).some((following) => isVisibleContent(following, false)))
						descriptors.push(SPACER_DESCRIPTOR);
					break;
				}
				case "providerNative":
					descriptors.push(
						{
							kind: "provider-native-summary",
							text: theme.fg("muted", formatProviderNativeSummary(message, content, this.expanded)),
						},
						{
							kind: "provider-native-body",
							text: theme.fg("dim", formatProviderNativeBody(content, this.expanded)),
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
				if (this.hasToolCalls) break;
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				addError(abortMessage);
				break;
			}
			case "error":
				if (!this.hasToolCalls) addError(`Error: ${message.errorMessage || "Unknown error"}`);
				break;
			case "stop":
			case "toolUse":
				break;
			default:
				assertNever(message.stopReason);
		}
		return descriptors;
	}

	private reconcileRenderDescriptors(descriptors: readonly RenderDescriptor[]): void {
		let divergentIndex = 0;
		const sharedLength = Math.min(this.renderDescriptors.length, descriptors.length);
		while (divergentIndex < sharedLength) {
			const previous = this.renderDescriptors[divergentIndex];
			const next = descriptors[divergentIndex];
			const child = this.contentContainer.children[divergentIndex];
			if (!previous || !next || !child || previous.kind !== next.kind) break;
			if (previous.text !== next.text) {
				if ((next.kind === "text-md" || next.kind === "thinking-md") && child instanceof Markdown) {
					child.setText(next.text);
				} else break;
			}
			divergentIndex++;
		}
		for (const child of this.contentContainer.children.splice(divergentIndex)) child.dispose?.();
		for (const descriptor of descriptors.slice(divergentIndex))
			this.contentContainer.addChild(this.createRenderChild(descriptor));
		this.renderDescriptors = descriptors;
	}

	private createRenderChild(descriptor: RenderDescriptor): Component {
		switch (descriptor.kind) {
			case "spacer":
				return new Spacer(1);
			case "text-md":
				return new Markdown(descriptor.text, this.outputPad, 0, this.markdownTheme);
			case "thinking-md":
				return new Markdown(descriptor.text, this.outputPad, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("thinkingText", text),
					italic: true,
				});
			case "thinking-label":
			case "error-text":
				return new Text(descriptor.text, this.outputPad, 0);
			case "provider-native-summary":
				return new Text(descriptor.text, 1, 0);
			case "provider-native-body":
				return new Text(descriptor.text, 3, 0);
			default:
				return assertNever(descriptor.kind);
		}
	}

	private createMessageSignature(message: AssistantMessage): string {
		return createBoundedRenderSignature({
			content: message.content,
			hiddenThinkingLabel: this.hiddenThinkingLabel,
			hideThinkingBlock: this.hideThinkingBlock,
			errorMessage: message.errorMessage,
			stopReason: message.stopReason,
		});
	}

	private cacheRender(width: number, signature: string, lines: string[]): void {
		this.renderCache = { lines: [...lines], signature, width };
	}

	private refreshContent(): void {
		if (!this.lastMessage) return;
		this.lastMessageSignature = undefined;
		this.updateContent(this.lastMessage);
	}
}
