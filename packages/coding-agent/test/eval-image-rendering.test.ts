import { ProcessTerminal, resetCapabilitiesCache, setCapabilities, TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("eval renderer image integration", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		resetCapabilitiesCache();
	});

	it("Given an image-capable terminal when a custom result renders then its context exposes the image protocol", () => {
		// Given
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		let observedImageProtocol: unknown;
		const toolDefinition: ToolDefinition = {
			name: "image_context_qa",
			label: "image_context_qa",
			description: "renderer image capability context test",
			parameters: Type.Object({}),
			execute: async () => ({ content: [], details: undefined }),
			renderResult: (_result, _options, _theme, context) => {
				observedImageProtocol = Reflect.get(context, "imageProtocol");
				return { render: () => ["custom result"], invalidate: () => {} };
			},
		};
		const component = new ToolExecutionComponent(
			"image_context_qa",
			"eval-image",
			{},
			{ showImages: true },
			toolDefinition,
			new TUI(new ProcessTerminal()),
			process.cwd(),
		);
		component.updateResult({
			content: [{ type: "image", data: ONE_PIXEL_PNG, mimeType: "image/png" }],
			details: { language: "js", durationMs: 1, toolCalls: [], truncated: false },
			isError: false,
		});

		// When
		const rendered = component.render(80).join("\n");

		// Then
		expect(observedImageProtocol).toBe("kitty");
		expect(rendered).toContain("\x1b_G");
	});
});
