import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { kernelToolDescriptorSchema } from "../src/bridge/kernel-tools-protocol.ts";
import type { KernelToolDescriptor } from "../src/index.ts";

describe("kernel tool descriptors name any eval language", () => {
	it("Given a descriptor from a Python kernel when it is typed and validated then it is accepted", () => {
		const fromPython: KernelToolDescriptor = {
			name: "add",
			description: "adds two numbers",
			input_schema: { type: "object" },
			language: "py",
			kernel_generation: 0,
			definition_revision: 1,
		};

		expect(Value.Check(kernelToolDescriptorSchema, fromPython)).toBe(true);
	});

	it("Given a descriptor naming a language codemode does not run when it is validated then it is rejected", () => {
		const unknown = {
			name: "add",
			description: "adds two numbers",
			input_schema: { type: "object" },
			language: "lua",
			kernel_generation: 0,
			definition_revision: 1,
		};

		expect(Value.Check(kernelToolDescriptorSchema, unknown)).toBe(false);
	});
});
