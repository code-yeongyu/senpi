import { ProcessTerminal, resetCapabilitiesCache, setCapabilities, TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import * as imageConvert from "../src/utils/image-convert.ts";

const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const STALE_ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const TINY_JPEG =
	"/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAIDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAGCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AD3VTB3/2Q==";
const INVALID_JPEG = Buffer.from("not-a-jpeg").toString("base64");

describe("eval renderer image integration", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		vi.restoreAllMocks();
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

	it("Given Kitty when a valid JPEG conversion completes then the fallback is replaced by the native image", async () => {
		// Given
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const toolDefinition: ToolDefinition = {
			name: "image_conversion_qa",
			label: "image_conversion_qa",
			description: "renderer image conversion transition test",
			parameters: Type.Object({}),
			execute: async () => ({ content: [], details: undefined }),
			renderResult: () => ({ render: () => ["custom result"], invalidate: () => {} }),
		};
		const component = new ToolExecutionComponent(
			"image_conversion_qa",
			"eval-image-conversion",
			{},
			{ showImages: true },
			toolDefinition,
			new TUI(new ProcessTerminal()),
			process.cwd(),
		);
		component.updateResult({
			content: [{ type: "image", data: TINY_JPEG, mimeType: "image/jpeg" }],
			details: { language: "js", durationMs: 1, toolCalls: [], truncated: false },
			isError: false,
		});
		expect(component.render(80).join("\n")).toContain("[image: image/jpeg]");

		// When
		await vi.waitFor(
			() => {
				const rendered = component.render(80).join("\n");
				expect(rendered).toContain("\x1b_G");
				expect(rendered).not.toContain("[image: image/jpeg]");
			},
			{ timeout: 3000, interval: 10 },
		);
	});

	it("Given Kitty when a custom renderer returns an invalid JPEG then the host renders an image fallback", () => {
		// Given
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const toolDefinition: ToolDefinition = {
			name: "image_fallback_qa",
			label: "image_fallback_qa",
			description: "renderer image fallback test",
			parameters: Type.Object({}),
			execute: async () => ({ content: [], details: undefined }),
			renderResult: () => ({ render: () => ["custom result"], invalidate: () => {} }),
		};
		const component = new ToolExecutionComponent(
			"image_fallback_qa",
			"eval-image-fallback",
			{},
			{ showImages: true },
			toolDefinition,
			new TUI(new ProcessTerminal()),
			process.cwd(),
		);
		component.updateResult({
			content: [{ type: "image", data: INVALID_JPEG, mimeType: "image/jpeg" }],
			details: { language: "js", durationMs: 1, toolCalls: [], truncated: false },
			isError: false,
		});

		// When
		const rendered = component.render(80).join("\n");

		// Then
		expect(rendered).toContain("[image: image/jpeg]");
		expect(rendered).not.toContain("\x1b_G");
	});

	it("Given a completed JPEG conversion at index 0 when an invalid JPEG replaces it then the fallback replaces the stale Kitty image", async () => {
		// Given
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const convertToPngSpy = vi.spyOn(imageConvert, "convertToPng");
		const toolDefinition: ToolDefinition = {
			name: "image_replacement_qa",
			label: "image_replacement_qa",
			description: "renderer stale converted image replacement test",
			parameters: Type.Object({}),
			execute: async () => ({ content: [], details: undefined }),
			renderResult: () => ({ render: () => ["custom result"], invalidate: () => {} }),
		};
		const component = new ToolExecutionComponent(
			"image_replacement_qa",
			"eval-image-replacement",
			{},
			{ showImages: true },
			toolDefinition,
			new TUI(new ProcessTerminal()),
			process.cwd(),
		);
		component.updateResult({
			content: [{ type: "image", data: TINY_JPEG, mimeType: "image/jpeg" }],
			details: { language: "js", durationMs: 1, toolCalls: [], truncated: false },
			isError: false,
		});
		expect(convertToPngSpy).toHaveBeenCalledTimes(1);
		await convertToPngSpy.mock.results[0]?.value;
		expect(component.render(80).join("\n")).toContain("\x1b_G");

		// When
		component.updateResult({
			content: [{ type: "image", data: INVALID_JPEG, mimeType: "image/jpeg" }],
			details: { language: "js", durationMs: 2, toolCalls: [], truncated: false },
			isError: false,
		});
		const rendered = component.render(80).join("\n");

		// Then
		expect({
			hasFallback: rendered.includes("[image: image/jpeg]"),
			hasKittyPayload: rendered.includes("\x1b_G"),
		}).toEqual({ hasFallback: true, hasKittyPayload: false });
	});

	it("Given a deferred JPEG conversion when a final PNG replaces it then the stale callback cannot overwrite the final image", async () => {
		// Given
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		let resolveFirstConversion: (value: Awaited<ReturnType<typeof imageConvert.convertToPng>>) => void = () => {};
		const firstConversion = new Promise<Awaited<ReturnType<typeof imageConvert.convertToPng>>>((resolve) => {
			resolveFirstConversion = resolve;
		});
		const convertToPngSpy = vi.spyOn(imageConvert, "convertToPng").mockReturnValueOnce(firstConversion);
		const toolDefinition: ToolDefinition = {
			name: "image_callback_qa",
			label: "image_callback_qa",
			description: "renderer stale conversion callback test",
			parameters: Type.Object({}),
			execute: async () => ({ content: [], details: undefined }),
			renderResult: () => ({ render: () => ["custom result"], invalidate: () => {} }),
		};
		const component = new ToolExecutionComponent(
			"image_callback_qa",
			"eval-image-callback",
			{},
			{ showImages: true },
			toolDefinition,
			new TUI(new ProcessTerminal()),
			process.cwd(),
		);
		component.updateResult({
			content: [{ type: "image", data: TINY_JPEG, mimeType: "image/jpeg" }],
			details: { language: "js", durationMs: 1, toolCalls: [], truncated: false },
			isError: false,
		});
		expect(convertToPngSpy).toHaveBeenCalledTimes(1);
		component.updateResult({
			content: [{ type: "image", data: ONE_PIXEL_PNG, mimeType: "image/png" }],
			details: { language: "js", durationMs: 2, toolCalls: [], truncated: false },
			isError: false,
		});
		expect(component.render(80).join("\n")).toContain(ONE_PIXEL_PNG);

		// When
		resolveFirstConversion({ data: STALE_ONE_PIXEL_PNG, mimeType: "image/png" });
		await firstConversion;
		const rendered = component.render(80).join("\n");

		// Then
		expect({
			hasFinalPayload: rendered.includes(ONE_PIXEL_PNG),
			hasStalePayload: rendered.includes(STALE_ONE_PIXEL_PNG),
		}).toEqual({ hasFinalPayload: true, hasStalePayload: false });
	});
});
