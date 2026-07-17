import { describe, expect, it } from "vitest";
import {
	normalizeToolParametersForMoonshot,
	normalizeToolParametersForOpenAICompat,
} from "../src/utils/tool-schema-compat.ts";

describe("tool-schema-compat", () => {
	describe("normalizeToolParametersForOpenAICompat", () => {
		it("removes a sibling type keyword from anyOf nodes", () => {
			const schema = {
				type: "object",
				properties: {
					mode: {
						type: "string",
						anyOf: [
							{ type: "string", const: "fast" },
							{ type: "string", const: "slow" },
						],
					},
				},
			};

			const normalized = normalizeToolParametersForOpenAICompat(schema);

			expect(normalized).toEqual({
				type: "object",
				properties: {
					mode: {
						type: "string",
						enum: ["fast", "slow"],
					},
				},
			});
		});

		it("moves a parent type into untyped combiner branches", () => {
			const schema = {
				type: "object",
				anyOf: [{ properties: { a: { type: "string" } } }, { properties: { b: { type: "number" } } }],
			};

			const normalized = normalizeToolParametersForOpenAICompat(schema);

			expect(normalized).toEqual({
				anyOf: [
					{ type: "object", properties: { a: { type: "string" } } },
					{ type: "object", properties: { b: { type: "number" } } },
				],
			});
		});

		it("collapses a homogeneous const union into a typed enum", () => {
			const schema = {
				anyOf: [
					{ type: "string", const: "alpha" },
					{ type: "string", const: "beta" },
				],
			};

			const normalized = normalizeToolParametersForOpenAICompat(schema);

			expect(normalized).toEqual({ type: "string", enum: ["alpha", "beta"] });
		});

		it("recurses through nested properties and items", () => {
			const schema = {
				type: "object",
				properties: {
					tags: {
						type: "array",
						items: {
							type: "string",
							anyOf: [
								{ type: "string", const: "x" },
								{ type: "string", const: "y" },
							],
						},
					},
				},
			};

			const normalized = normalizeToolParametersForOpenAICompat(schema);

			expect(normalized).toEqual({
				type: "object",
				properties: {
					tags: {
						type: "array",
						items: { type: "string", enum: ["x", "y"] },
					},
				},
			});
		});
	});

	describe("normalizeToolParametersForMoonshot", () => {
		it("strips format and examples annotations", () => {
			const schema = {
				type: "object",
				properties: {
					when: {
						type: "string",
						format: "date-time",
						examples: ["2025-01-01T00:00:00Z"],
						anyOf: [{ type: "string", const: "now" }],
					},
				},
			};

			const normalized = normalizeToolParametersForMoonshot(schema);

			expect(normalized).toEqual({
				type: "object",
				properties: {
					when: {
						anyOf: [{ type: "string", const: "now" }],
					},
				},
			});
		});
	});
});
