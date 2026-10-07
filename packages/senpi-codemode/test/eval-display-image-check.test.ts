import type { AgentToolResult } from "@code-yeongyu/senpi";
import { describe, expect, it, vi } from "vitest";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import { FakeKernel, FakeManager, fakeExtensionContext, result } from "./eval/fakes.ts";

type ToolResult = AgentToolResult<unknown>;
type ToolContent = ToolResult["content"][number];
type ImagePart = Extract<ToolContent, { type: "image" }>;

// Base64 of the leading bytes of each format; only the signature is inspected.
const PNG = "iVBORw0KGgo=";
const JPEG = "/9j/4A==";
const GIF = "R0lGODlh";
const WEBP = "UklGRgAAAABXRUJQ";

const NOT_BASE64 = "[display: image dropped \u2014 the image data is not valid base64 (truncated or corrupted?)]";
const NOT_AN_IMAGE = "[display: image dropped \u2014 the image data is not a PNG, JPEG, GIF, or WebP image]";

function isImagePart(part: ToolContent): part is ImagePart {
	return part.type === "image";
}

function textOf(toolResult: ToolResult): string {
	return toolResult.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

async function displayImage(mimeType: string, dataBase64: string): Promise<ToolResult> {
	const kernel = new FakeKernel([{ type: "display", mimeType, dataBase64 }, result("image-cell", "")]);
	const tool = createEvalTool({
		enabledLanguages: { js: true, py: false, rb: false, jl: false },
		kernelManager: new FakeManager([["js", kernel]]),
		cellTimeoutSeconds: 30,
		executeTool: vi.fn(),
		imageResizer: async (image) => ({ image }),
	});
	return tool.execute(
		"image-cell",
		{ language: "js", code: "display(image)", summary: "display image" },
		undefined,
		undefined,
		fakeExtensionContext(),
	);
}

describe("eval display image validation", () => {
	it.each([
		["a non-base64 character", "AAAA!"],
		["a length that is not a multiple of four", "AAAAA"],
		["padding in the middle", "AA=A"],
		["no data", ""],
		["a truncation marker appended", "iVBORw0KGgoAAAA\n[Output truncated]"],
	])(
		"Given image data with %s when displayed then no image block is kept and the output says why",
		async (_case, data) => {
			// When
			const toolResult = await displayImage("image/png", data);

			// Then
			expect(toolResult.content.filter(isImagePart)).toEqual([]);
			expect(textOf(toolResult)).toContain(NOT_BASE64);
		},
	);

	it.each([
		["plain text bytes", "QUJD"],
		["zero bytes", "AAAA"],
		["a JPEG-LS signature", "/9j/9w=="],
		["a BMP signature", "Qk0AAAAA"],
	])(
		"Given valid base64 of %s when displayed as an image then it is dropped with a clear reason",
		async (_case, data) => {
			// When
			const toolResult = await displayImage("image/png", data);

			// Then
			expect(toolResult.content.filter(isImagePart)).toEqual([]);
			expect(textOf(toolResult)).toContain(NOT_AN_IMAGE);
		},
	);

	it.each([
		["image/png", PNG, "image/png"],
		["image/jpeg", JPEG, "image/jpeg"],
		["image/gif", GIF, "image/gif"],
		["image/png", WEBP, "image/webp"],
		["image/jpeg", PNG, "image/png"],
	])(
		"Given %s declared over data whose signature is %s when displayed then the detected type is kept",
		async (declared, data, detected) => {
			// When
			const toolResult = await displayImage(declared, data);

			// Then
			expect(toolResult.content.filter(isImagePart)).toEqual([{ type: "image", mimeType: detected, data }]);
			expect(textOf(toolResult)).not.toContain("image dropped");
		},
	);

	it("Given wrapped base64 when displayed then the line breaks are dropped and the image is kept", async () => {
		// When
		const toolResult = await displayImage("image/png", "iVBORw0K\r\nGgo=\n");

		// Then
		expect(toolResult.content.filter(isImagePart)).toEqual([{ type: "image", mimeType: "image/png", data: PNG }]);
	});
});
