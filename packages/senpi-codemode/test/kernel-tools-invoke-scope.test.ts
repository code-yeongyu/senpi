import { describe, expect, it } from "vitest";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";
import { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";
import type {
	KernelToolDescriptor,
	KernelToolsInvokeOptions,
	KernelToolsInvokeScope,
} from "../src/kernels/js/kernel-tools-types.ts";

type ToolCallMessage = Extract<KernelToHostMessage, { type: "tool-call" }>;
type ResultMessage = Extract<KernelToHostMessage, { type: "result" }>;

/**
 * The parent cell registers the closures an in-process child would be granted, then parks on a host
 * tool so every invoke below runs against a live cell on the reentrant pump.
 */
const PARENT_CELL = [
	"tool(async function fetch_path(path) { return await tool.read({ path }); });",
	"tool(async function store_path(path) { return await tool.write({ path, content: 'body' }); });",
	"tool(async function guarded_store(path) {",
	"  try {",
	"    await tool.write({ path, content: 'body' });",
	"    return { denied: null };",
	"  } catch (error) {",
	"    return { denied: { name: error.name, code: error.code, details: error.details } };",
	"  }",
	"});",
	"await tool.hold({});",
	"return 'parent-done';",
].join("\n");

type ScopeHarness = {
	readonly kernel: JavaScriptKernel;
	readonly hostToolCalls: readonly string[];
	readonly parent: Promise<ResultMessage>;
	readonly hold: ToolCallMessage;
	invoke(name: string, callId: string, options?: KernelToolsInvokeOptions): Promise<unknown>;
	nextHostCall(): Promise<ToolCallMessage>;
};

function scope(tools: KernelToolsInvokeScope["tools"]): KernelToolsInvokeOptions {
	return { scope: { tools } };
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
	const timeout = Promise.withResolvers<never>();
	const timer = setTimeout(() => timeout.reject(new Error(`${label} timed out after 8000ms`)), 8_000);
	try {
		return await Promise.race([promise, timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}

async function withScopedParent<T>(fn: (harness: ScopeHarness) => Promise<T>): Promise<T> {
	const hostToolCalls: string[] = [];
	const kernel = new JavaScriptKernel({
		sessionId: "kernel-tools-invoke-scope",
		cwd: process.cwd(),
		parallelPoolWidth: 2,
		onMessage: (message) => {
			if (message.type === "tool-call") hostToolCalls.push(message.toolName);
		},
	});
	try {
		const parent = kernel.run({ cellId: "scope-parent", code: PARENT_CELL, timeoutMs: 8_000 });
		const hold = await bounded(kernel.nextToolCall(), "parent hold");
		expect(hold.toolName).toBe("hold");
		const described = await kernel.describeKernelTools(["fetch_path", "store_path", "guarded_store"]);
		const descriptors = new Map<string, KernelToolDescriptor>();
		for (const entry of described.results) {
			if (!entry.ok) throw new Error(`descriptor missing: ${entry.name}`);
			descriptors.set(entry.name, entry.descriptor);
		}
		return await fn({
			kernel,
			hostToolCalls,
			parent,
			hold,
			invoke: (name, callId, options) => {
				const descriptor = descriptors.get(name);
				if (!descriptor) throw new Error(`descriptor missing: ${name}`);
				return kernel.invokeKernelTool(
					{
						name: descriptor.name,
						kernel_generation: descriptor.kernel_generation,
						definition_revision: descriptor.definition_revision,
						args: { path: "demo.txt" },
						call_id: callId,
					},
					options,
				);
			},
			nextHostCall: () => bounded(kernel.nextToolCall(), "nested host call"),
		});
	} finally {
		await kernel.close();
	}
}

/** Call-scoped host-tool policy for kernel-tool invoke (https://github.com/code-yeongyu/senpi/issues/1731). */
describe("kernel-tool invoke scope", () => {
	it("refuses a denied nested host call on the invoking call's channel without touching the bridge", async () => {
		await withScopedParent(async (harness) => {
			const invoke = harness.invoke("store_path", "deny-1", scope({ deny: ["write"] }));
			await expect(invoke).rejects.toMatchObject({
				code: "kernel_tool_host_denied",
				details: { tool: "write", call_id: "deny-1", reason: "deny" },
			});
			expect(harness.hostToolCalls).toEqual(["hold"]);
		});
	});

	it("hands the closure a rejected promise it can observe, keeping the invoke successful", async () => {
		await withScopedParent(async (harness) => {
			await expect(harness.invoke("guarded_store", "deny-2", scope({ deny: ["write"] }))).resolves.toEqual({
				denied: {
					name: "KernelToolError",
					code: "kernel_tool_host_denied",
					details: { tool: "write", call_id: "deny-2", reason: "deny" },
				},
			});
			expect(harness.hostToolCalls).toEqual(["hold"]);
		});
	});

	it("lets an allowed nested host call cross the bridge under the same scope", async () => {
		await withScopedParent(async (harness) => {
			const invoke = harness.invoke("fetch_path", "allow-1", scope({ allow: ["read"], deny: ["write"] }));
			const read = await harness.nextHostCall();
			expect(read).toMatchObject({ toolName: "read", args: { path: "demo.txt" } });
			harness.kernel.deliverToolReply({ type: "tool-reply", callId: read.callId, ok: true, value: "nested-body" });
			await expect(invoke).resolves.toBe("nested-body");
		});
	});

	it("refuses a host tool outside the allow list with reason allow", async () => {
		await withScopedParent(async (harness) => {
			await expect(harness.invoke("store_path", "allow-2", scope({ allow: ["read"] }))).rejects.toMatchObject({
				code: "kernel_tool_host_denied",
				details: { tool: "write", call_id: "allow-2", reason: "allow" },
			});
			expect(harness.hostToolCalls).toEqual(["hold"]);
		});
	});

	it("lets deny win over allow when a tool appears in both lists", async () => {
		await withScopedParent(async (harness) => {
			await expect(
				harness.invoke("store_path", "both-1", scope({ allow: ["read", "write"], deny: ["write"] })),
			).rejects.toMatchObject({
				code: "kernel_tool_host_denied",
				details: { tool: "write", call_id: "both-1", reason: "deny" },
			});
		});
	});

	it("keeps an invoke without scope on today's path", async () => {
		await withScopedParent(async (harness) => {
			const invoke = harness.invoke("store_path", "plain-1");
			const write = await harness.nextHostCall();
			expect(write).toMatchObject({ toolName: "write", args: { path: "demo.txt", content: "body" } });
			harness.kernel.deliverToolReply({
				type: "tool-reply",
				callId: write.callId,
				ok: true,
				value: "/tmp/demo.txt",
			});
			await expect(invoke).resolves.toBe("/tmp/demo.txt");
		});
	});

	it("drops the scope when the call settles, so the next invoke runs unscoped", async () => {
		await withScopedParent(async (harness) => {
			await expect(harness.invoke("store_path", "scoped-1", scope({ deny: ["write"] }))).rejects.toMatchObject({
				code: "kernel_tool_host_denied",
			});
			const invoke = harness.invoke("store_path", "unscoped-2");
			const write = await harness.nextHostCall();
			expect(write.toolName).toBe("write");
			harness.kernel.deliverToolReply({
				type: "tool-reply",
				callId: write.callId,
				ok: true,
				value: "/tmp/demo.txt",
			});
			await expect(invoke).resolves.toBe("/tmp/demo.txt");
		});
	});

	it("settles a scoped nested wait exactly once when the parent is interrupted", async () => {
		await withScopedParent(async (harness) => {
			const invoke = harness.invoke("fetch_path", "interrupt-1", scope({ allow: ["read"] }));
			const read = await harness.nextHostCall();
			expect(read.toolName).toBe("read");
			let settles = 0;
			const tracked = invoke.then(
				(value) => {
					settles += 1;
					return { ok: true as const, value };
				},
				(error: unknown) => {
					settles += 1;
					return {
						ok: false as const,
						code: error instanceof Error && "code" in error ? String(error.code) : "unknown",
					};
				},
			);
			await harness.kernel.interrupt("verify-scoped-interrupt");
			await expect(bounded(harness.parent, "parent cell")).resolves.toMatchObject({
				ok: false,
				error: { message: "JS cell interrupted: verify-scoped-interrupt" },
			});
			await expect(bounded(tracked, "scoped nested invoke")).resolves.toMatchObject({
				ok: false,
				code: "kernel_tool_stale",
			});
			expect(settles).toBe(1);
		});
	});

	it("leaves the parent's own cell, queue and later cells unaffected by a refusal", async () => {
		await withScopedParent(async (harness) => {
			const queued = harness.kernel.run({
				cellId: "scope-parent-next",
				code: "return await tool.write({ path: 'top-level.txt', content: 'x' });",
				timeoutMs: 8_000,
			});
			await expect(harness.invoke("store_path", "deny-3", scope({ deny: ["write"] }))).rejects.toMatchObject({
				code: "kernel_tool_host_denied",
			});
			expect(harness.hostToolCalls).toEqual(["hold"]);
			harness.kernel.deliverToolReply({ type: "tool-reply", callId: harness.hold.callId, ok: true, value: "held" });
			await expect(bounded(harness.parent, "parent cell")).resolves.toMatchObject({
				ok: true,
				valueRepr: '"parent-done"',
			});
			const topLevelWrite = await harness.nextHostCall();
			expect(topLevelWrite).toMatchObject({ toolName: "write", args: { path: "top-level.txt" } });
			harness.kernel.deliverToolReply({
				type: "tool-reply",
				callId: topLevelWrite.callId,
				ok: true,
				value: "/tmp/top-level.txt",
			});
			await expect(bounded(queued, "queued cell")).resolves.toMatchObject({
				ok: true,
				valueRepr: '"/tmp/top-level.txt"',
			});
		});
	});
});
