import { describe, expect, it } from "vitest";
import { DEFAULT_IMAGE_MODEL } from "../src/core/extensions/builtin/imagegen/params.ts";
import { applyImageGenerationTools } from "../src/core/extensions/builtin/openai-image-gen/inject.ts";

const GENERATE_IMAGE = { type: "function", name: "generate_image", parameters: { type: "object" } };
const READ = { type: "function", name: "read", parameters: { type: "object" } };

function tools(payload: unknown): unknown[] {
	if (typeof payload !== "object" || payload === null || !("tools" in payload) || !Array.isArray(payload.tools)) {
		throw new Error("payload carries no tools array");
	}
	return payload.tools;
}

describe("native image_generation injection", () => {
	it("injects the server tool pinned to the default image model", () => {
		const payload = applyImageGenerationTools({ tools: [GENERATE_IMAGE, READ] }, "native");
		expect(tools(payload)).toEqual([READ, { type: "image_generation", model: DEFAULT_IMAGE_MODEL }]);
		expect(DEFAULT_IMAGE_MODEL).toBe("gpt-image-2.5-sunburst");
	});

	it("replaces pre-existing native entries so exactly one pinned entry remains", () => {
		const payload = applyImageGenerationTools(
			{ tools: [{ type: "image_generation" }, READ, { type: "image_generation", model: "gpt-image-1" }] },
			"native",
		);
		expect(tools(payload)).toEqual([READ, { type: "image_generation", model: DEFAULT_IMAGE_MODEL }]);
	});

	it("strips native entries in client mode and both tools when unavailable", () => {
		const payload = { tools: [{ type: "image_generation", model: DEFAULT_IMAGE_MODEL }, GENERATE_IMAGE, READ] };
		expect(tools(applyImageGenerationTools(payload, "client"))).toEqual([GENERATE_IMAGE, READ]);
		expect(tools(applyImageGenerationTools(payload, "unavailable"))).toEqual([READ]);
	});

	it("returns the original payload reference when nothing changes", () => {
		const payload = { tools: [GENERATE_IMAGE, READ] };
		expect(applyImageGenerationTools(payload, "client")).toBe(payload);
	});
});
