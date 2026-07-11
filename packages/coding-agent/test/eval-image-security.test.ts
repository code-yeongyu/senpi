import { ProcessTerminal, resetCapabilitiesCache, setCapabilities, TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import * as imageConvert from "../src/utils/image-convert.ts";

const INVALID_JPEG = Buffer.from("not-a-jpeg").toString("base64");
const TERMINAL_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const TERMINAL_CSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/gu;

describe("eval renderer image security", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetCapabilitiesCache();
	});

	it("Given Kitty when a custom renderer returns a hostile MIME label then the fallback has no terminal controls", () => {
		// Given
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const hostileMimeType = "image/png\x1b]52;c;SGVsbG8=\x07";
		const convertToPngSpy = vi.spyOn(imageConvert, "convertToPng").mockResolvedValue(null);
		const toolDefinition: ToolDefinition = {
			name: "image_hostile_fallback_qa",
			label: "image_hostile_fallback_qa",
			description: "renderer hostile image fallback test",
			parameters: Type.Object({}),
			execute: async () => ({ content: [], details: undefined }),
			renderResult: () => ({ render: () => ["custom result"], invalidate: () => {} }),
		};
		const component = new ToolExecutionComponent(
			"image_hostile_fallback_qa",
			"eval-image-hostile-fallback",
			{},
			{ showImages: true },
			toolDefinition,
			new TUI(new ProcessTerminal()),
			process.cwd(),
		);
		component.updateResult({
			content: [{ type: "image", data: INVALID_JPEG, mimeType: hostileMimeType }],
			details: { language: "js", durationMs: 1, toolCalls: [], truncated: false },
			isError: false,
		});

		// When
		const renderedLabel = component
			.render(80)
			.join("\n")
			.replace(TERMINAL_CSI_PATTERN, "")
			.split("\n")
			.find((line) => line.includes("[image:"))
			?.trim();

		// Then
		expect(convertToPngSpy).toHaveBeenCalledWith(INVALID_JPEG, hostileMimeType);
		expect(renderedLabel).toBe("[image: image/png]");
		expect(renderedLabel).not.toMatch(TERMINAL_CONTROL_PATTERN);
		expect(renderedLabel).not.toContain("\x1b");
		expect(renderedLabel).not.toContain("\x07");
		expect(renderedLabel).not.toContain("\x1b]");
	});
});
