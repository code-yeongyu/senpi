import { afterEach, describe, expect, it } from "vitest";
import { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";

const kernels: JavaScriptKernel[] = [];

afterEach(async () => {
	for (const kernel of kernels.splice(0)) await kernel.close();
});

function kernel(): JavaScriptKernel {
	const created = new JavaScriptKernel({
		sessionId: `kernel-tools-defined-${crypto.randomUUID()}`,
		cwd: process.cwd(),
		parallelPoolWidth: 1,
		onMessage: () => undefined,
	});
	kernels.push(created);
	return created;
}

async function run(target: JavaScriptKernel, code: string): Promise<string> {
	const result = await target.run({ cellId: `cell-${crypto.randomUUID()}`, code, timeoutMs: 20_000 });
	if (!result.ok) throw new Error(result.error.message);
	return result.valueRepr ?? "";
}

describe("Given a JavaScript kernel with kernel tools", () => {
	it("js-tool-explicit-name-preserves-argument-order: metadata.name registers the alias, and the positional order still comes from the function", async () => {
		const target = kernel();
		await run(target, 'function subtract(a, b) { return a - b }; tool(subtract, { name: "minus" }); "ok"');

		const described = await target.describeKernelTools(["minus", "subtract"]);
		const minus = described.results[0];
		if (!minus?.ok) throw new Error("minus was not described");
		const value = await target.invokeKernelTool({
			name: "minus",
			kernel_generation: minus.descriptor.kernel_generation,
			definition_revision: minus.descriptor.definition_revision,
			args: { b: 3, a: 10 },
			call_id: "call-1",
		});

		expect(minus.descriptor.name).toBe("minus");
		expect(minus.descriptor.input_schema).toMatchObject({ required: ["a", "b"] });
		expect(described.results[1]).toMatchObject({ ok: false, error: { code: "kernel_tool_missing" } });
		expect(value).toBe(7);
	}, 30_000);

	it("tool.defined() lists the registered names sorted, and tool.undefine(name) removes one and reports whether it existed", async () => {
		const target = kernel();
		await run(
			target,
			'function mid() { return 0 }; function zeta() { return 1 }; function alpha() { return 2 }; tool(mid); tool(zeta); tool(alpha); "ok"',
		);

		const before = await run(target, "tool.defined()");
		const removed = await run(target, '[tool.undefine("zeta"), tool.undefine("zeta"), tool.undefine(42)]');
		const after = await run(target, "tool.defined()");
		const described = await target.describeKernelTools(["zeta"]);

		expect(JSON.parse(before)).toEqual(["alpha", "mid", "zeta"]);
		expect(JSON.parse(removed)).toEqual([true, false, false]);
		expect(JSON.parse(after)).toEqual(["alpha", "mid"]);
		expect(described.results[0]).toMatchObject({ ok: false, error: { code: "kernel_tool_missing" } });
	}, 30_000);

	it("a descriptor taken before undefine() can no longer be invoked", async () => {
		const target = kernel();
		await run(target, 'function double(n) { return n * 2 }; tool(double); "ok"');
		const described = await target.describeKernelTools(["double"]);
		const entry = described.results[0];
		if (!entry?.ok) throw new Error("double was not described");

		await run(target, 'tool.undefine("double")');

		await expect(
			target.invokeKernelTool({
				name: "double",
				kernel_generation: entry.descriptor.kernel_generation,
				definition_revision: entry.descriptor.definition_revision,
				args: { n: 2 },
				call_id: "call-2",
			}),
		).rejects.toMatchObject({ code: "kernel_tool_missing" });
	}, 30_000);

	it("a non-string metadata.name is refused with invalid_tool_definition and nothing is registered", async () => {
		const target = kernel();

		await expect(run(target, "function f(a) { return a }; tool(f, { name: 7 })")).rejects.toThrow(
			"name must be a string",
		);
		expect(JSON.parse(await run(target, "tool.defined()"))).toEqual([]);
	}, 30_000);

	it("an alias that is not a valid tool name is refused", async () => {
		const target = kernel();

		await expect(run(target, 'function f(a) { return a }; tool(f, { name: "has space" })')).rejects.toThrow(
			"MCP name grammar",
		);
	}, 30_000);
	it.each(["defined", "undefine"])(
		"registering a kernel tool named %s is refused with reserved_tool_name, by alias or by function name",
		async (name) => {
			const target = kernel();

			await expect(run(target, `function f(a) { return a }; tool(f, { name: "${name}" })`)).rejects.toThrow(
				`Kernel tool name is reserved: ${name}`,
			);
			await expect(run(target, `function ${name}(a) { return a }; tool(${name})`)).rejects.toThrow(
				`Kernel tool name is reserved: ${name}`,
			);
			expect(JSON.parse(await run(target, "tool.defined()"))).toEqual([]);
		},
		30_000,
	);
});
