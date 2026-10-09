import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonical } from "../../scripts/gate-report.ts";
import { measureSurfaces } from "../../scripts/gate-surfaces.ts";

describe("regression surface matrix", () => {
	it("covers every dialect and capability cell when measuring the real prompt builder", async () => {
		// Given
		const target = fileURLToPath(new URL("../..", import.meta.url));
		// When
		const surfaces = await measureSurfaces(target);
		// Then: the coverage keys, not prose wording, are the contract.
		const expected = ["default", "claude", "codex", "gpt", "kimi"].flatMap((model) =>
			[false, true].flatMap((spawns) =>
				[false, true].flatMap((monitor) =>
					["js", "js+py", "all"].flatMap((set) =>
						["bun", "node"].flatMap((runtime) =>
							["", "/host"].map((host) => `${model}/${spawns}/${monitor}/${set}/${runtime}${host}`),
						),
					),
				),
			),
		);
		expect(Object.keys(surfaces.prompts).sort()).toEqual(expected.sort());
		// Each language set has its default schema and, measured separately, the shape with sandbox cells on.
		expect(Object.keys(surfaces.schemas).sort()).toEqual(
			["all", "all+sandbox", "js", "js+py", "js+py+sandbox", "js+sandbox"].sort(),
		);
		expect(surfaces.prompts["gpt/true/true/all/bun"]).toBeDefined();
		expect(surfaces.prompts["default/false/false/js/node"]).toBeDefined();
		expect(surfaces.prompts["gpt/true/true/all/bun/host"]).toBeDefined();
	});

	it("preserves character content while ignoring JSON object insertion order", () => {
		// Given
		const input = { second: ["abc"], first: 1 };
		// When
		const value = canonical(input);
		// Then
		expect(value).toBe(canonical({ first: 1, second: ["abc"] }));
		expect(value).not.toBe(canonical({ first: 1, second: ["abd"] }));
		expect(canonical({ "\u00e9": 1, "e\u0301": 2 })).toBe(canonical({ "e\u0301": 2, "\u00e9": 1 }));
	});
});
