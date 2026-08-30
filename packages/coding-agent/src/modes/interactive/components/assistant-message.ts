import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	type Component,
	Container,
	Markdown,
	type MarkdownTheme,
	Spacer,
	Text,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { type AssistantRenderDescriptor, createAssistantRenderDescriptors } from "./assistant-render-descriptors.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";
import { createBoundedRenderSignature } from "./render-signature.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

function assertNever(value: never): never {
	throw new TypeError(`Unexpected assistant render variant: ${String(value)}`);
}

export class AssistantMessageComponent extends Container {
	private renderCache?: { readonly lines: string[]; readonly signature: string; readonly width: number };
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private lastMessage?: AssistantMessage;
	private lastMessageSignature?: string;
	private renderDescriptors: readonly AssistantRenderDescriptor[] = [];
	private hasToolCalls = false;
	private expanded = false;
	private isStreaming = false;
	private showTimestamps: boolean;
	private timestampEligible: boolean;
	// Stamped once when the message arrives, never at render time: render() is
	// cache-backed and re-runs on resize, so reading the clock there would make a
	// past message silently change its own timestamp.
	private arrivedAt?: Date;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
		showTimestamps = false,
		timestamp?: { readonly eligible: boolean; readonly arrivedAt?: Date },
	) {
		super();

		this.showTimestamps = showTimestamps;
		this.timestampEligible = timestamp?.eligible ?? true;
		this.arrivedAt = timestamp?.arrivedAt;
		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;

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

	setShowTimestamps(show: boolean): void {
		if (this.showTimestamps === show) return;
		this.showTimestamps = show;
		this.invalidate();
	}

	setTimestampEligible(eligible: boolean): void {
		if (this.timestampEligible === eligible) return;
		this.timestampEligible = eligible;
		this.invalidate();
	}

	hasVisibleContent(): boolean {
		return this.renderDescriptors.some((descriptor) => descriptor.kind !== "spacer");
	}

	getArrivedAt(): Date | undefined {
		return this.arrivedAt;
	}

	private timestampPrefix(): string {
		if (!this.showTimestamps || !this.timestampEligible) return "";
		const at = this.arrivedAt ?? new Date();
		const hh = String(at.getHours()).padStart(2, "0");
		const mm = String(at.getMinutes()).padStart(2, "0");
		const ss = String(at.getSeconds()).padStart(2, "0");
		return theme.fg("dim", `${hh}:${mm}:${ss} `);
	}

	override render(width: number): string[] {
		const signature = this.lastMessageSignature ?? "";
		if (this.renderCache?.width === width && this.renderCache.signature === signature) {
			return [...this.renderCache.lines];
		}

		const prefix = this.timestampPrefix();
		const prefixWidth = visibleWidth(prefix);
		const showTimestamp = prefixWidth > 0 && width > prefixWidth;
		let lines = super.render(showTimestamp ? width - prefixWidth : width);
		const firstContentLineIndex = lines.findIndex((line) => visibleWidth(line) > 0);
		if (firstContentLineIndex >= 0 && showTimestamp) {
			const prefixedLine = prefix + lines[firstContentLineIndex];
			if (visibleWidth(prefixedLine) <= width) {
				lines[firstContentLineIndex] = prefixedLine;
			} else {
				lines = super.render(width);
			}
		}
		if (this.hasToolCalls || lines.length === 0) {
			this.cacheRender(width, signature, lines);
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		this.cacheRender(width, signature, lines);
		return lines;
	}

	updateContent(message: AssistantMessage, isStreaming = this.isStreaming): void {
		// First delta only. updateContent runs once per streaming chunk, so stamping
		// unconditionally would march the clock forward while the message is still
		// being written and land on the completion time rather than the start.
		this.arrivedAt ??= new Date();
		const previousMessage = this.lastMessage;
		const streamingChanged = this.isStreaming !== isStreaming;
		this.isStreaming = isStreaming;
		this.lastMessage = message;
		const messageSignature = this.createMessageSignature(message);
		if (!streamingChanged && previousMessage === message && this.lastMessageSignature === messageSignature) {
			return;
		}
		this.lastMessageSignature = messageSignature;
		this.renderCache = undefined;
		if (streamingChanged) this.renderDescriptors = [];
		this.hasToolCalls = message.content.some((content) => content.type === "toolCall");
		const descriptors = createAssistantRenderDescriptors(message, {
			expanded: this.expanded,
			hiddenThinkingLabel: this.hiddenThinkingLabel,
			hideThinkingBlock: this.hideThinkingBlock,
			hasToolCalls: this.hasToolCalls,
		});
		this.reconcileRenderDescriptors(descriptors);
	}

	private reconcileRenderDescriptors(descriptors: readonly AssistantRenderDescriptor[]): void {
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

	private createRenderChild(descriptor: AssistantRenderDescriptor): Component {
		switch (descriptor.kind) {
			case "spacer":
				return new Spacer(1);
			case "text-md":
				return new Markdown(descriptor.text, this.outputPad, 0, this.markdownTheme, undefined, {
					transform: createMarkdownTransform("assistant", this.isStreaming, this.markdownTransformers),
				});
			case "thinking-md":
				return new Markdown(
					descriptor.text,
					this.outputPad,
					0,
					this.markdownTheme,
					{
						color: (text: string) => theme.fg("thinkingText", text),
						italic: true,
					},
					{
						transform: createMarkdownTransform("assistant-thinking", this.isStreaming, this.markdownTransformers),
					},
				);
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
			errorState: [message.diagnostics, message.errorMessage],
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
