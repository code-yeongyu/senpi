import { describe, expect, it } from "vitest";
import { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";

async function withKernel<T>(
	fn: (kernel: JavaScriptKernel) => Promise<T>,
	options: {
		hostToolNames?: readonly string[] | (() => readonly string[]);
		foreignLanguageNames?: readonly string[] | (() => readonly string[]);
	} = {},
): Promise<T> {
	const kernel = new JavaScriptKernel({
		sessionId: "kernel-tools-protocol",
		cwd: process.cwd(),
		parallelPoolWidth: 2,
		...options,
	});
	try {
		return await fn(kernel);
	} finally {
		await kernel.close();
	}
}

describe("kernel tool protocol", () => {
	it("describes and invokes on the live worker without enqueueing behind the active run", async () => {
		await withKernel(async (kernel) => {
			const run = kernel.run({
				cellId: "outer-hold",
				code: "tool(async function lookup(path) { return await tool.read({ path }); }); await tool.hold({}); return 7;",
				timeoutMs: 8_000,
			});
			const hold = await kernel.nextToolCall();
			expect(hold).toMatchObject({ type: "tool-call", toolName: "hold" });
			const described = await kernel.describeKernelTools(["lookup", "missing"]);
			expect(described.results.map((entry) => entry.name)).toEqual(["lookup", "missing"]);
			expect(described.results[0]).toMatchObject({
				ok: true,
				descriptor: { name: "lookup", language: "js" },
			});
			expect(described.results[1]).toMatchObject({ ok: false, error: { code: "kernel_tool_missing" } });
			const descriptor = described.results[0].ok ? described.results[0].descriptor : undefined;
			if (!descriptor) throw new Error("lookup descriptor missing");
			const invoke = kernel.invokeKernelTool({
				name: "lookup",
				kernel_generation: descriptor.kernel_generation,
				definition_revision: descriptor.definition_revision,
				args: { path: "x" },
				call_id: "child-1",
			});
			const readCall = await kernel.nextToolCall();
			expect(readCall.toolName).toBe("read");
			expect(readCall.callId).not.toBe(hold.callId);
			kernel.deliverToolReply({ type: "tool-reply", callId: readCall.callId, ok: true, value: "from-host" });
			await expect(invoke).resolves.toBe("from-host");
			kernel.deliverToolReply({ type: "tool-reply", callId: hold.callId, ok: true, value: "held" });
			await expect(run).resolves.toMatchObject({ ok: true, valueRepr: "7" });
		});
	});

	it("rejects stale generation after reset and recursive agent() with typed errors", async () => {
		await withKernel(async (kernel) => {
			const run = kernel.run({
				cellId: "outer-reset",
				code: "tool(async function lookup(path) { return await tool.read({ path }); }); tool(async function bad() { return await agent('nope'); }); await tool.hold({}); return 1;",
				timeoutMs: 8_000,
			});
			const hold = await kernel.nextToolCall();
			const described = await kernel.describeKernelTools(["lookup", "bad"]);
			const lookup = described.results[0]?.ok ? described.results[0].descriptor : undefined;
			const bad = described.results[1]?.ok ? described.results[1].descriptor : undefined;
			if (!lookup || !bad) throw new Error("descriptors missing");
			await expect(
				kernel.invokeKernelTool({
					name: "bad",
					kernel_generation: bad.kernel_generation,
					definition_revision: bad.definition_revision,
					args: {},
					call_id: "recurse",
				}),
			).rejects.toMatchObject({ code: "kernel_tool_recursion" });
			const pending = kernel.invokeKernelTool({
				name: "lookup",
				kernel_generation: lookup.kernel_generation,
				definition_revision: lookup.definition_revision,
				args: { path: "x" },
				call_id: "pending-reset",
			});
			const stale = pending.then(
				() => {
					throw new Error("pending invoke settled");
				},
				(error: unknown) => error,
			);
			await kernel.nextToolCall();
			await kernel.reset();
			await expect(stale).resolves.toMatchObject({ code: "kernel_tool_stale" });
			void hold;
			void run;
		});
	});

	it("rejects host and foreign names on the live worker registry", async () => {
		await withKernel(
			async (kernel) => {
				const read = await kernel.run({
					cellId: "collide-read",
					code: "try { tool(function read(path) { return path; }); } catch (e) { return e.code; }",
					timeoutMs: 8_000,
				});
				expect(read).toMatchObject({ ok: true, valueRepr: '"tool_name_collision"' });
				const py = await kernel.run({
					cellId: "collide-py",
					code: "try { tool(function py_lookup(path) { return path; }); } catch (e) { return e.code; }",
					timeoutMs: 8_000,
				});
				expect(py).toMatchObject({ ok: true, valueRepr: '"tool_name_collision"' });
			},
			{ hostToolNames: ["read", "bash"], foreignLanguageNames: ["py_lookup"] },
		);
	});

	it("rejects a host tool attached after kernel start", async () => {
		const hostToolNames = ["read"];
		await withKernel(
			async (kernel) => {
				const boot = await kernel.run({
					cellId: "boot-host",
					code: "return 1",
					timeoutMs: 8_000,
				});
				expect(boot).toMatchObject({ ok: true, valueRepr: "1" });
				hostToolNames.push("mcp_attached");
				const attached = await kernel.run({
					cellId: "collide-attached",
					code: "try { tool(function mcp_attached(a) { return a; }); } catch (e) { return e.code; }",
					timeoutMs: 8_000,
				});
				expect(attached).toMatchObject({ ok: true, valueRepr: '"tool_name_collision"' });
			},
			{ hostToolNames: () => hostToolNames },
		);
	});

	it("rejects workpool recursion and redefinition during a pending nested invoke", async () => {
		await withKernel(async (kernel) => {
			const run = kernel.run({
				cellId: "redef-workpool",
				code: "tool(async function lookup(path) { return await tool.read({ path }); }); tool(async function pooled() { return await workpool('a', 'b'); }); await tool.hold({}); tool(function lookup(path) { return 'new'; }); return 1;",
				timeoutMs: 8_000,
			});
			const hold = await kernel.nextToolCall();
			const described = await kernel.describeKernelTools(["lookup", "pooled"]);
			const lookup = described.results[0]?.ok ? described.results[0].descriptor : undefined;
			const pooled = described.results[1]?.ok ? described.results[1].descriptor : undefined;
			if (!lookup || !pooled) throw new Error("descriptors missing");
			await expect(
				kernel.invokeKernelTool({
					name: "pooled",
					kernel_generation: pooled.kernel_generation,
					definition_revision: pooled.definition_revision,
					args: {},
					call_id: "workpool",
				}),
			).rejects.toMatchObject({ code: "kernel_tool_recursion" });
			const nested = Promise.withResolvers<void>();
			kernel.kernelToolEvents.addEventListener("nestedInvoke", () => nested.resolve(), { once: true });
			const invoke = kernel.invokeKernelTool({
				name: "lookup",
				kernel_generation: lookup.kernel_generation,
				definition_revision: lookup.definition_revision,
				args: { path: "x" },
				call_id: "redef",
			});
			await nested.promise;
			const readCall = await kernel.nextToolCall();
			kernel.deliverToolReply({ type: "tool-reply", callId: hold.callId, ok: true, value: "held" });
			await expect(run).resolves.toMatchObject({ ok: true, valueRepr: "1" });
			kernel.deliverToolReply({ type: "tool-reply", callId: readCall.callId, ok: true, value: "late" });
			await expect(invoke).rejects.toMatchObject({ code: "kernel_tool_stale" });
		});
	});
});
