import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type Component, Container, Markdown } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, test } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type RenderConfiguration = {
	readonly expanded?: boolean;
	readonly hideThinkingBlock?: boolean;
	readonly outputPad?: number;
};

type RenderParityCase = {
	readonly configuration?: RenderConfiguration;
	readonly finalMessage: AssistantMessage;
	readonly initialMessage: AssistantMessage;
	readonly name: string;
	readonly width?: number;
};

function createAssistantMessage(
	content: AssistantMessage["content"],
	overrides: Partial<Pick<AssistantMessage, "errorMessage" | "stopReason">> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: overrides.stopReason ?? "stop",
		errorMessage: overrides.errorMessage,
		timestamp: 0,
	};
}

function createComponent(
	message: AssistantMessage,
	configuration: RenderConfiguration = {},
): AssistantMessageComponent {
	const component = new AssistantMessageComponent(message, configuration.hideThinkingBlock ?? false);
	if (configuration.expanded !== undefined) {
		component.setExpanded(configuration.expanded);
	}
	if (configuration.outputPad !== undefined) {
		component.setOutputPad(configuration.outputPad);
	}
	return component;
}

function getContentChildren(component: AssistantMessageComponent): readonly Component[] {
	const contentContainer = component.children[0];
	if (!(contentContainer instanceof Container)) {
		throw new TypeError("Assistant message content child must be a Container");
	}
	return contentContainer.children;
}

function getRequiredChild(component: AssistantMessageComponent, index: number): Component {
	const child = getContentChildren(component)[index];
	if (!child) {
		throw new RangeError(`Missing assistant content child at index ${index}`);
	}
	return child;
}

function getRequiredMarkdown(component: AssistantMessageComponent, index: number): Markdown {
	const markdownChildren = getContentChildren(component).filter(
		(child): child is Markdown => child instanceof Markdown,
	);
	const child = markdownChildren[index];
	if (!child) {
		throw new RangeError(`Missing assistant Markdown child at index ${index}`);
	}
	return child;
}

const renderParityCases: readonly RenderParityCase[] = [
	{
		name: "text-only streaming",
		initialMessage: createAssistantMessage([{ type: "text", text: "draft" }]),
		finalMessage: createAssistantMessage([{ type: "text", text: "final **answer**" }]),
	},
	{
		name: "visible adjacent thinking and text",
		initialMessage: createAssistantMessage([
			{ type: "thinking", thinking: "first thought" },
			{ type: "text", text: "partial" },
		]),
		finalMessage: createAssistantMessage([
			{ type: "thinking", thinking: "first thought" },
			{ type: "thinking", thinking: "second thought" },
			{ type: "text", text: "complete" },
		]),
	},
	{
		name: "collapsed provider-native content",
		initialMessage: createAssistantMessage([
			{ type: "providerNative", subtype: "status", raw: { status: "running" } },
		]),
		finalMessage: createAssistantMessage([
			{ type: "providerNative", subtype: "status", raw: { status: "complete", result: "ready" } },
		]),
	},
	{
		name: "expanded provider-native content",
		configuration: { expanded: true },
		initialMessage: createAssistantMessage([
			{ type: "providerNative", subtype: "status", raw: { status: "running" } },
		]),
		finalMessage: createAssistantMessage([
			{ type: "providerNative", subtype: "status", raw: { status: "complete", result: "ready" } },
		]),
		width: 120,
	},
	{
		name: "length stop tail",
		initialMessage: createAssistantMessage([{ type: "text", text: "partial" }]),
		finalMessage: createAssistantMessage([{ type: "text", text: "partial" }], { stopReason: "length" }),
	},
	{
		name: "aborted stop tail",
		initialMessage: createAssistantMessage([{ type: "text", text: "partial" }]),
		finalMessage: createAssistantMessage([{ type: "text", text: "partial" }], {
			stopReason: "aborted",
			errorMessage: "Request was aborted",
		}),
	},
	{
		name: "error stop tail",
		initialMessage: createAssistantMessage([{ type: "text", text: "partial" }]),
		finalMessage: createAssistantMessage([{ type: "text", text: "partial" }], {
			stopReason: "error",
			errorMessage: "network disconnected",
		}),
	},
	{
		name: "hidden adjacent thinking with custom output padding",
		configuration: { hideThinkingBlock: true, outputPad: 2 },
		initialMessage: createAssistantMessage([{ type: "thinking", thinking: "first thought" }]),
		finalMessage: createAssistantMessage([
			{ type: "thinking", thinking: "first thought" },
			{ type: "thinking", thinking: "second thought" },
			{ type: "text", text: "answer" },
		]),
	},
];

describe("AssistantMessageComponent incremental rendering", () => {
	beforeEach(() => {
		initTheme("dark");
	});

	for (const parityCase of renderParityCases) {
		test(`#given ${parityCase.name} #when content updates incrementally #then raw output matches a fresh final render`, () => {
			const incremental = createComponent(parityCase.initialMessage, parityCase.configuration);
			incremental.updateContent(parityCase.finalMessage);
			const fresh = createComponent(parityCase.finalMessage, parityCase.configuration);
			const width = parityCase.width ?? 80;

			expect(incremental.render(width)).toEqual(fresh.render(width));
		});
	}

	test("#given an unchanged leading block #when tail Markdown grows #then preserves the leading child identity", () => {
		const component = createComponent(
			createAssistantMessage([
				{ type: "text", text: "prefix" },
				{ type: "text", text: "tail" },
			]),
		);
		const leadingMarkdown = getRequiredMarkdown(component, 0);

		component.updateContent(
			createAssistantMessage([
				{ type: "text", text: "prefix" },
				{ type: "text", text: "tail grows" },
			]),
		);

		expect(getRequiredMarkdown(component, 0)).toBe(leadingMarkdown);
	});

	test("#given a streaming Markdown block #when its text grows #then preserves identity and updates output", () => {
		const component = createComponent(createAssistantMessage([{ type: "text", text: "draft" }]));
		const markdown = getRequiredMarkdown(component, 0);
		const before = component.render(80);

		component.updateContent(createAssistantMessage([{ type: "text", text: "complete answer" }]));
		const after = component.render(80);

		expect(getRequiredMarkdown(component, 0)).toBe(markdown);
		expect(after).not.toEqual(before);
		expect(after.join("\n")).toContain("complete answer");
		expect(after.join("\n")).not.toContain("draft");
	});

	test("#given a stable prefix #when kind and list shape diverge #then rebuilds only the suffix", () => {
		const component = createComponent(
			createAssistantMessage([
				{ type: "text", text: "prefix" },
				{ type: "text", text: "tail" },
			]),
		);
		const initialSpacer = getRequiredChild(component, 0);
		const initialPrefix = getRequiredChild(component, 1);
		const initialTail = getRequiredChild(component, 2);
		const initialLength = getContentChildren(component).length;

		component.updateContent(
			createAssistantMessage([
				{ type: "text", text: "prefix" },
				{ type: "thinking", thinking: "new reasoning" },
				{ type: "text", text: "tail" },
			]),
		);

		expect(getRequiredChild(component, 0)).toBe(initialSpacer);
		expect(getRequiredChild(component, 1)).toBe(initialPrefix);
		expect(getRequiredChild(component, 2)).not.toBe(initialTail);
		expect(getContentChildren(component).length).toBeGreaterThan(initialLength);
	});
});
