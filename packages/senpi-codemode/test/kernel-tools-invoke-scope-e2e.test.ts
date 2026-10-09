import {
	type AgentToolResult,
	type ExtensionContext,
	type ExtensionToolContext,
	kernelToolsStorage,
} from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it } from "vitest";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";
import { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";
import type { KernelToolsDescribeResult } from "../src/kernels/js/kernel-tools-types.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import type {
	EvalKernel,
	EvalKernelManager,
	EvalLanguage,
	EvalToolCallSummary,
	EvalToolDetails,
} from "../src/tool/types.ts";
import { fakeExtensionContext } from "./eval/fakes.ts";

type ProbeArgs = { readonly path: string };

function isProbeArgs(value: unknown): value is ProbeArgs {
	return typeof value === "object" && value !== null && "path" in value && typeof value.path === "string";
}

function isKernelToolsDescribeResult(value: unknown): value is KernelToolsDescribeResult {
	return typeof value === "object" && value !== null && "results" in value && Array.isArray(value.results);
}

type DeniedRecord = { readonly code?: string; readonly details?: unknown };

type HostObservation = {
	readonly invokeScope: boolean;
	readonly guarded: unknown;
	readonly strict: DeniedRecord;
};

/** The read the shipped host performs: `ExtensionContext.kernelTools` is a live `kernelToolsStorage.getStore()`. */
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
			sessionId: "kernel-tools-invoke-scope-e2e",
			cwd: process.cwd(),
			parallelPoolWidth: 2,
			onMessage: (message) => this.#dispatch?.(message),
		});
		return this.#kernel;
	}

	async close(): Promise<void> {
		await this.#kernel?.close();
	}
}

function textResult(text: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details: {} };
}

function outputText(cell: AgentToolResult<EvalToolDetails>): string {
	const part = cell.content[0];
	return part?.type === "text" ? part.text : "";
}

function byName(left: { readonly name: string }, right: { readonly name: string }): number {
	return left.name.localeCompare(right.name);
}

function deniedRecord(error: unknown): DeniedRecord {
	if (!(error instanceof Error)) return { code: "unknown" };
	return {
		...("code" in error ? { code: String(error.code) } : {}),
		...("details" in error ? { details: error.details } : {}),
	};
}

/**
 * A host tool that resolves the parent's kernel-tool capability exactly like a task/agent tool
 * serving a child grant does, then invokes the parent's closures under a call scope that denies the
 * host `write` tool.
 */
function scopedProbeTool(ctx: ExtensionContext, observations: HostObservation[], hostCalls: string[]) {
	return async (toolName: string, params: unknown): Promise<AgentToolResult<unknown>> => {
		hostCalls.push(toolName);
		if (toolName === "read") return textResult("file-body");
		if (toolName === "write") return textResult("host-write-happened");
		if (!isProbeArgs(params)) throw new Error(`probe expected { path: string }, got ${JSON.stringify(params)}`);
		const probe = params;
		const kernelTools = ctx.kernelTools;
		if (kernelTools === undefined) throw new Error("kernel tools unavailable at the host dispatch point");
		const described = await kernelTools.describe(["guarded_fs", "strict_fs"]);
		if (!isKernelToolsDescribeResult(described)) throw new Error("describe returned an unexpected shape");
		const guardedEntry = described.results[0];
		const strictEntry = described.results[1];
		if (guardedEntry?.ok !== true || strictEntry?.ok !== true) throw new Error("kernel tool descriptors missing");
		const scope = { tools: { deny: ["write"] } };
		const guarded = await kernelTools.invoke(
			{
				name: guardedEntry.descriptor.name,
				kernel_generation: guardedEntry.descriptor.kernel_generation,
				definition_revision: guardedEntry.descriptor.definition_revision,
				args: { path: probe.path },
				call_id: "child-guarded",
			},
			{ scope },
		);
		let strict: DeniedRecord = { code: "resolved" };
		try {
			await kernelTools.invoke(
				{
					name: strictEntry.descriptor.name,
					kernel_generation: strictEntry.descriptor.kernel_generation,
					definition_revision: strictEntry.descriptor.definition_revision,
					args: { path: probe.path },
					call_id: "child-strict",
				},
				{ scope },
			);
		} catch (error) {
			strict = deniedRecord(error);
		}
		observations.push({ invokeScope: kernelTools.capabilities.invokeScope, guarded, strict });
		return textResult(JSON.stringify({ guarded, strict }));
	};
}

const CELL_CODE = [
	"tool(async function guarded_fs(path) {",
	"  const read = await tool.read({ path });",
	"  try {",
	"    await tool.write({ path, content: 'body' });",
	"    return { read: read.text, denied: null };",
	"  } catch (error) {",
	"    return { read: read.text, denied: { code: error.code, details: error.details } };",
	"  }",
	"});",
	"tool(async function strict_fs(path) {",
	"  await tool.write({ path, content: 'body' });",
	"  return 'unreachable';",
	"});",
	"return (await tool.probe({ path: 'demo.txt' })).text;",
].join("\n");

/** Call-scoped host-tool policy on the real worker (https://github.com/code-yeongyu/senpi/issues/1731). */
describe("kernel-tool invoke scope on the real worker tool-call path", () => {
	let manager: LiveJavaScriptKernelManager | undefined;

	afterEach(async () => {
		await manager?.close();
		manager = undefined;
	});

	it("runs an allowed nested host call and fails the denied one closed on the invoking call", async () => {
		manager = new LiveJavaScriptKernelManager();
		const ctx = hostContext();
		const observations: HostObservation[] = [];
		const hostCalls: string[] = [];
		const tool = createEvalTool({
			enabledLanguages: { js: true, py: false, rb: false, jl: false },
			kernelManager: manager,
			cellTimeoutSeconds: 30,
			executeTool: scopedProbeTool(ctx, observations, hostCalls),
		});

		const cell = await tool.execute(
			"kernel-tools-invoke-scope-e2e",
			{
				language: "js",
				code: CELL_CODE,
				summary: "register kernel tools whose closures call host read and write, then scope the invokes",
			},
			undefined,
			undefined,
			ctx,
		);

		expect(observations).toEqual([
			{
				invokeScope: true,
				guarded: {
					read: "file-body",
					denied: {
						code: "kernel_tool_host_denied",
						details: { tool: "write", call_id: "child-guarded", reason: "deny" },
					},
				},
				strict: {
					code: "kernel_tool_host_denied",
					details: { tool: "write", call_id: "child-strict", reason: "deny" },
				},
			},
		]);
		expect(hostCalls).toEqual(["probe", "read"]);
		expect(cell.details.isError).toBeFalsy();
		// The nested read settles before the probe that drove it, so compare the captured set, not order.
		const captured = cell.details.toolCalls.map((call: EvalToolCallSummary) => ({ name: call.name, ok: call.ok }));
		expect(captured.sort(byName)).toEqual([
			{ name: "probe", ok: true },
			{ name: "read", ok: true },
		]);
		expect(outputText(cell)).toContain("kernel_tool_host_denied");
		expect(ctx.kernelTools).toBeUndefined();
	});
});
