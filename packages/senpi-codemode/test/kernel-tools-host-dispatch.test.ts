import { AsyncResource } from "node:async_hooks";
import {
	type AgentToolResult,
	type ExtensionContext,
	type ExtensionToolContext,
	kernelToolsStorage,
} from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it } from "vitest";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";
import { ReplaceableKernel } from "../src/extension/kernel-replacement.ts";
import { hasKernelTools } from "../src/extension/kernel-tools-probe.ts";
import { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";
import type { KernelToolsDescribeResult } from "../src/kernels/js/kernel-tools-types.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import type { EvalKernel, EvalKernelManager, EvalLanguage, EvalToolDetails } from "../src/tool/types.ts";
import { FakeKernel, FakeManager, fakeExtensionContext, result } from "./eval/fakes.ts";

type ProbeArgs = { readonly phase: string; readonly tool?: string; readonly arg?: number };

function isProbeArgs(value: unknown): value is ProbeArgs {
	return typeof value === "object" && value !== null && "phase" in value && typeof value.phase === "string";
}

function isKernelToolsDescribeResult(value: unknown): value is KernelToolsDescribeResult {
	return typeof value === "object" && value !== null && "results" in value && Array.isArray(value.results);
}

type HostObservation = {
	readonly phase: string;
	readonly kernelToolsDefined: boolean;
	readonly descriptorName?: string;
	readonly invoked?: unknown;
	readonly failure?: string;
};

/**
 * The read the shipped host performs: `ExtensionContext.kernelTools` is a live
 * `kernelToolsStorage.getStore()` in packages/coding-agent/src/core/extensions/runner.ts, resolved
 * when a tool's `execute` touches it.
 */
function hostContext(): ExtensionToolContext {
	return {
		...fakeExtensionContext(),
		get kernelTools() {
			return kernelToolsStorage.getStore();
		},
	};
}

/** Mirrors the session manager: one persistent JS kernel whose onMessage is rebound per cell. */
class LiveJavaScriptKernelManager implements EvalKernelManager {
	#kernel: JavaScriptKernel | undefined;
	#dispatch: ((message: KernelToHostMessage) => void) | undefined;

	async getKernel(language: EvalLanguage, onMessage: (message: KernelToHostMessage) => void): Promise<EvalKernel> {
		if (language !== "js") throw new Error(`this manager only serves js kernels, got ${language}`);
		this.#dispatch = onMessage;
		this.#kernel ??= new JavaScriptKernel({
			sessionId: "kernel-tools-host-dispatch",
			cwd: process.cwd(),
			parallelPoolWidth: 2,
			onMessage: (message) => this.#dispatch?.(message),
		});
		return this.#kernel;
	}

	/**
	 * Brings the worker up before any eval cell runs: the state of every cell after the first and of
	 * every cell after a kernel restart. Such a worker's message loop shares no async context with the
	 * cell it dispatches for, which is exactly what the capability must not depend on (#1754).
	 */
	async startWorker(): Promise<JavaScriptKernel> {
		const kernel = await this.getKernel("js", () => undefined);
		if (!(kernel instanceof JavaScriptKernel)) throw new Error("this manager only serves JavaScriptKernel instances");
		const warmUp = await kernel.run({ cellId: "warm-up", code: "1", timeoutMs: 8_000 });
		if (!warmUp.ok) throw new Error(`warm-up cell failed: ${warmUp.error.message}`);
		return kernel;
	}

	async close(): Promise<void> {
		await this.#kernel?.close();
	}
}

async function describeThrough(kernel: EvalKernel): Promise<unknown> {
	if (!hasKernelTools(kernel)) throw new Error("the kernel exposes no kernel tools");
	return await kernel.describeKernelTools(["add"]);
}

function textResult(text: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details: {} };
}

function outputText(cell: AgentToolResult<EvalToolDetails>): string {
	const part = cell.content[0];
	return part?.type === "text" ? part.text : "";
}

/**
 * A host tool that reads `ctx.kernelTools` exactly like a task/agent tool resolving a kernel-tool
 * grant does, then drives describe + invoke against the tool the calling cell registered.
 */
function probingExecuteTool(ctx: ExtensionContext, observations: HostObservation[]) {
	return async (_toolName: string, params: unknown): Promise<AgentToolResult<unknown>> => {
		if (!isProbeArgs(params)) throw new Error(`probe expected { phase: string }, got ${JSON.stringify(params)}`);
		const probe = params;
		const kernelTools = ctx.kernelTools;
		if (!kernelTools) {
			observations.push({ phase: probe.phase, kernelToolsDefined: false });
			return textResult("kernel tools unavailable");
		}
		const described = await kernelTools.describe([probe.tool ?? ""]);
		if (!isKernelToolsDescribeResult(described)) throw new Error("describe returned an unexpected shape");
		const entry = described.results[0];
		if (entry?.ok !== true) {
			observations.push({ phase: probe.phase, kernelToolsDefined: true, failure: `describe refused ${probe.tool}` });
			return textResult("describe refused");
		}
		const invoked = await kernelTools.invoke({
			name: entry.descriptor.name,
			kernel_generation: entry.descriptor.kernel_generation,
			definition_revision: entry.descriptor.definition_revision,
			args: { n: probe.arg },
			call_id: `probe-${probe.phase}`,
		});
		observations.push({
			phase: probe.phase,
			kernelToolsDefined: true,
			descriptorName: entry.descriptor.name,
			invoked,
		});
		return textResult(JSON.stringify(invoked));
	};
}

function cellCode(phase: string, toolName: string, factor: number, arg: number): string {
	return `tool(function ${toolName}(n) { return n * ${factor}; });\nreturn (await tool.probe({ phase: '${phase}', tool: '${toolName}', arg: ${arg} })).text;`;
}

/** Regression coverage for https://github.com/code-yeongyu/senpi/issues/1754 (producer: #1647). */
describe("kernel tools on the real worker tool-call path", () => {
	let manager: LiveJavaScriptKernelManager | undefined;

	afterEach(async () => {
		await manager?.close();
		manager = undefined;
	});

	it("hands each live JS cell's host tool that cell's kernel-tool capability on a running worker", async () => {
		manager = new LiveJavaScriptKernelManager();
		const kernel = await manager.startWorker();
		expect(kernel.mode).toBe("worker");
		const ctx = hostContext();
		const observations: HostObservation[] = [];
		const tool = createEvalTool({
			enabledLanguages: { js: true, py: false, rb: false, jl: false },
			kernelManager: manager,
			cellTimeoutSeconds: 30,
			executeTool: probingExecuteTool(ctx, observations),
		});

		expect(ctx.kernelTools).toBeUndefined();
		const first = await tool.execute(
			"kernel-tools-host-dispatch-first",
			{
				language: "js",
				code: cellCode("first", "double", 2, 21),
				summary: "register a kernel tool, then call a host tool from the same cell",
			},
			undefined,
			undefined,
			ctx,
		);
		const second = await tool.execute(
			"kernel-tools-host-dispatch-second",
			{
				language: "js",
				code: cellCode("second", "triple", 3, 14),
				summary: "register another kernel tool and call a host tool again",
			},
			undefined,
			undefined,
			ctx,
		);
		expect(ctx.kernelTools).toBeUndefined();

		expect(observations).toEqual([
			{ phase: "first", kernelToolsDefined: true, descriptorName: "double", invoked: 42 },
			{ phase: "second", kernelToolsDefined: true, descriptorName: "triple", invoked: 42 },
		]);
		expect(first.details.isError).toBeFalsy();
		expect(second.details.isError).toBeFalsy();
		expect(first.details.toolCalls[0]).toMatchObject({ name: "probe", ok: true });
		expect(second.details.toolCalls[0]).toMatchObject({ name: "probe", ok: true });
		expect(outputText(first)).toContain('"42"');
		expect(outputText(second)).toContain('"42"');
	});

	it("hands the capability to the first cell of a session, which spawns the worker itself", async () => {
		manager = new LiveJavaScriptKernelManager();
		const ctx = hostContext();
		const observations: HostObservation[] = [];
		const tool = createEvalTool({
			enabledLanguages: { js: true, py: false, rb: false, jl: false },
			kernelManager: manager,
			cellTimeoutSeconds: 30,
			executeTool: probingExecuteTool(ctx, observations),
		});

		const cell = await tool.execute(
			"kernel-tools-host-dispatch-cold",
			{
				language: "js",
				code: cellCode("cold", "quadruple", 4, 10),
				summary: "first cell of a session registers a kernel tool and calls a host tool",
			},
			undefined,
			undefined,
			ctx,
		);

		expect(observations).toEqual([
			{ phase: "cold", kernelToolsDefined: true, descriptorName: "quadruple", invoked: 40 },
		]);
		expect(cell.details.toolCalls[0]).toMatchObject({ name: "probe", ok: true });
		expect(ctx.kernelTools).toBeUndefined();
	});

	it("leaves a host tool dispatched by a non-JS cell without a kernel-tool capability", async () => {
		// A stub py kernel keeps the negative interpreter-free: a kernel gets the capability only if it
		// exposes describe/invoke, and this one exposes neither.
		const kernel = new FakeKernel([
			{ type: "tool-call", callId: "py-1", toolName: "probe", args: { phase: "py" } },
			result("kernel-tools-host-dispatch-py", "done"),
		]);
		const workerContext = new AsyncResource("non-js-worker");
		const run = kernel.run.bind(kernel);
		kernel.run = (...args) => workerContext.runInAsyncScope(run, kernel, ...args);
		const ctx = hostContext();
		const observations: HostObservation[] = [];
		const executeTool = async (_toolName: string, params: unknown): Promise<AgentToolResult<unknown>> => {
			if (!isProbeArgs(params)) throw new Error(`probe expected { phase: string }, got ${JSON.stringify(params)}`);
			const probe = params;
			observations.push({ phase: probe.phase, kernelToolsDefined: ctx.kernelTools !== undefined });
			return textResult("host tool done");
		};
		const tool = createEvalTool({
			enabledLanguages: { js: false, py: true, rb: false, jl: false },
			kernelManager: new FakeManager([["py", kernel]]),
			cellTimeoutSeconds: 30,
			executeTool,
		});

		const cell = await kernelToolsStorage.run(
			{
				capabilities: { invokeScope: true },
				describe: async () => undefined,
				invoke: async () => undefined,
			},
			() =>
				tool.execute(
					"kernel-tools-host-dispatch-py",
					{
						language: "py",
						code: "tool.probe(phase='py')",
						summary: "call a host tool from a python cell",
					},
					undefined,
					undefined,
					ctx,
				),
		);
		workerContext.emitDestroy();

		expect(observations).toEqual([{ phase: "py", kernelToolsDefined: false }]);
		expect(cell.details.toolCalls[0]).toMatchObject({ name: "probe", ok: true });
		expect(ctx.kernelTools).toBeUndefined();
	});

	it("Given the replaceable kernel a session holds for rb and jl when it is probed for kernel tools then it exposes none of the interpreter's stubs", async () => {
		for (const language of ["rb", "jl"] as const) {
			const inner = Object.assign(new FakeKernel([]), {
				describeKernelTools: async () => {
					throw new Error("tools_unavailable");
				},
				invokeKernelTool: async () => {
					throw new Error("tools_unavailable");
				},
				drainPending: () => [],
			});
			const held = await ReplaceableKernel.create(language, async () => inner);

			expect("describeKernelTools" in held).toBe(false);
			expect("invokeKernelTool" in held).toBe(false);
			await held.close();
		}
	});

	it("Given the replaceable kernel a session holds for py when its interpreter is replaced then kernel tools reach only the new instance", async () => {
		const instances: string[] = [];
		const deaths: Array<() => void> = [];
		const start = async (lifecycle: { onDeath: (reason: string) => void }) => {
			const name = `instance-${instances.length + 1}`;
			instances.push(name);
			let alive = true;
			deaths.push(() => {
				alive = false;
				lifecycle.onDeath("interpreter exited");
			});
			return Object.assign(new FakeKernel([]), {
				describeKernelTools: async (names: readonly string[]): Promise<KernelToolsDescribeResult> => ({
					results: names.map((requested) => ({
						name: requested,
						ok: true as const,
						descriptor: {
							name: requested,
							description: `from ${name}`,
							input_schema: {},
							language: "py" as const,
							kernel_generation: 1,
							definition_revision: 1,
						},
					})),
				}),
				invokeKernelTool: async (): Promise<unknown> => name,
				drainPending: () => [],
				isAlive: () => alive,
			});
		};
		const held = await ReplaceableKernel.create("py", start);
		expect(hasKernelTools(held)).toBe(true);
		expect(await describeThrough(held)).toEqual({
			results: [
				{
					name: "add",
					ok: true,
					descriptor: {
						name: "add",
						description: "from instance-1",
						input_schema: {},
						language: "py",
						kernel_generation: 1,
						definition_revision: 1,
					},
				},
			],
		});

		deaths[0]?.();
		await held.reset();

		expect(instances).toEqual(["instance-1", "instance-2"]);
		expect(await describeThrough(held)).toEqual({
			results: [
				{
					name: "add",
					ok: true,
					descriptor: {
						name: "add",
						description: "from instance-2",
						input_schema: {},
						language: "py",
						kernel_generation: 1,
						definition_revision: 1,
					},
				},
			],
		});
		await held.close();
	});
});
