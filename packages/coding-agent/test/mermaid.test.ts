import { describe, expect, it } from "vitest";
import type { MarkdownTransformContext } from "../src/core/extensions/types.ts";
import type { MermaidRenderingMode } from "../src/core/settings-manager.ts";
import { createMermaidMarkdownTransformer } from "../src/modes/interactive/components/mermaid.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";

interface TransformOptions {
	maxWidth?: number;
	isStreaming?: boolean;
	messageType?: MarkdownTransformContext["messageType"];
	mode?: MermaidRenderingMode;
	theme?: Theme;
}

function transformMermaid(markdown: string, options: TransformOptions = {}): string {
	const transformer = createMermaidMarkdownTransformer({
		getMode: () => options.mode ?? "streaming",
		theme: options.theme,
	});
	return transformer(markdown, {
		availableWidth: options.maxWidth ?? 100,
		isStreaming: options.isStreaming ?? false,
		messageType: options.messageType ?? "assistant",
	});
}

describe("Mermaid rendering", () => {
	it("replaces Mermaid code blocks with Unicode diagrams", () => {
		const markdown = "Before\n\n```mermaid\nflowchart LR\n  A[Start] --> B[Done]\n```\nAfter";
		const rendered = transformMermaid(markdown);

		expect(rendered).toContain("Before");
		expect(rendered).toContain("┌───────┐");
		expect(rendered).toContain("│ Start ├───▶│ Done │");
		expect(rendered).toContain("└───────┘    └──────┘`\nAfter");
		expect(rendered).not.toContain("```mermaid");
		expect(rendered).toContain("After");
	});

	// senpi#5695: a no-op builtin must retain authored bytes for source selection.
	it.each(["\n", "\r\n", "\r"])("leaves ordinary Markdown unchanged with separator %j", (separator) => {
		const markdown =
			"Before\n\n---\n\nAfter\n\n**Bold** and *italic*.\n\nPlain text control: alpha beta gamma.\n\nUnselected".replaceAll(
				"\n",
				separator,
			);

		expect(transformMermaid(markdown)).toBe(markdown);
	});

	it.each(
		["\n", "\r\n", "\r"].flatMap((separator) => [
			{ name: "unsupported", separator, code: 'pie\n  title Pets\n  "Dogs" : 4', maxWidth: 100 },
			{ name: "oversized", separator, code: "flowchart LR\n  A[Start] --> B[Done]", maxWidth: 10 },
		]),
	)("leaves $name diagrams unchanged with separator $separator", ({ separator, code, maxWidth }) => {
		const markdown = `\`\`\`mermaid\n${code}\n\`\`\``.replaceAll("\n", separator);

		expect(transformMermaid(markdown, { maxWidth })).toBe(markdown);
	});

	it("maps semantic spans through the Pi theme", () => {
		const theme = {
			fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
			bold: (text: string) => `<bold>${text}</bold>`,
		} as Theme;
		const rendered = transformMermaid("```mermaid\nflowchart LR\n  A --> B\n```", { theme });

		expect(rendered).toContain("<borderMuted>");
		expect(rendered).toContain("<accent>");
	});

	it("renders incomplete Mermaid blocks during streaming", () => {
		const partialMarkdown = "```mermaid\nflowchart LR\n  A --> B";

		expect(transformMermaid(partialMarkdown, { isStreaming: true })).toContain("───▶");
	});

	it("renders diagrams with class assignments", () => {
		const markdown = "```mermaid\nflowchart LR\n  A[Foo]:::highlight --> B[Bar]\n```";
		const rendered = transformMermaid(markdown);

		expect(rendered).not.toContain("```mermaid");
		expect(rendered).not.toContain("Mermaid diagram not rendered");
		expect(rendered).toContain("│ Foo ├───▶│ Bar │");
	});

	it("falls back to the code block with a warning after streaming", () => {
		const markdown = "```mermaid\nflowchart LR\n  A[Foo] invalid\n```";
		const final = transformMermaid(markdown);
		const followedByText = transformMermaid(`${markdown}\nFollowing text`);
		const streaming = transformMermaid(markdown, { isStreaming: true });

		expect(final).toContain(markdown);
		expect(final).toContain("```\n`Mermaid diagram not rendered");
		expect(final).toContain('dropped, expected a link: "invalid"');
		expect(final).not.toContain("more)");
		expect(followedByText).toContain("  \nFollowing text");
		expect(streaming).not.toContain("Mermaid diagram not rendered");
		expect(streaming).not.toContain("```mermaid");
		expect(streaming).toContain("│ Foo │");
	});

	it("summarizes additional partial-render warnings", () => {
		const markdown = "```mermaid\nflowchart LR\n  A[Foo] invalid\n  B[Bar] also-invalid\n```";
		const rendered = transformMermaid(markdown);

		expect(rendered).toContain(markdown);
		expect(rendered).toContain('dropped, expected a link: "invalid"');
		expect(rendered).toContain("(+1 more)");
		expect(rendered).not.toContain('dropped, expected a link: "also-invalid"');
	});

	it("respects rendering modes and skips thinking blocks", () => {
		const markdown = "```mermaid\nflowchart LR\n  A --> B\n```";

		expect(transformMermaid(markdown, { mode: "off" })).toBe(markdown);
		expect(transformMermaid(markdown, { mode: "final", isStreaming: true })).toBe(markdown);
		expect(transformMermaid(markdown, { mode: "final" })).not.toContain("```mermaid");
		expect(transformMermaid(markdown, { messageType: "assistant-thinking" })).toBe(markdown);
	});
});
