import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { RESERVED_AGENT_TOOL } from "../../packages/senpi-codemode/src/bridge/reserved.ts";
import { JavaScriptKernel } from "../../packages/senpi-codemode/src/kernels/js/context-manager.ts";

const FENCE_MS = 8_000;

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
	const timeout = Promise.withResolvers<never>();
	const timer = setTimeout(() => timeout.reject(new Error(`${label} timed out after ${FENCE_MS}ms`)), FENCE_MS);
	try {
		return await Promise.race([promise, timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}

async function withKernel<T>(fn: (kernel: JavaScriptKernel) => Promise<T>): Promise<T> {
	const kernel = new JavaScriptKernel({
		sessionId: "omp-item6-qa",
		cwd: process.cwd(),
		parallelPoolWidth: 2,
	});
	try {
		return await fn(kernel);
	} finally {
		await kernel.close();
	}
}

async function workerParentAwaitsChild() {
	return await withKernel(async (kernel) => {
		const events: string[] = [];
		const outer = Promise.withResolvers<void>();
		kernel.kernelToolEvents.addEventListener(
			"outerAwaitingAgent",
			() => {
				events.push("outerAwaitingAgent");
				outer.resolve();
			},
			{ once: true },
		);
		const run = kernel.run({
			cellId: "qa-parent",
			code: "tool(async function lookup(path) { return await tool.read({ path }); }); return await agent('child', { tools: ['lookup'] });",
			timeoutMs: FENCE_MS,
		});
		const agentCall = await bounded(kernel.nextToolCall(), "agent-call");
		assert.equal(agentCall.toolName, RESERVED_AGENT_TOOL);
		await bounded(outer.promise, "outerAwaitingAgent");
		const described = await kernel.describeKernelTools(["lookup"]);
		const descriptor = described.results[0]?.ok ? described.results[0].descriptor : undefined;
		assert(descriptor);
		const nested = Promise.withResolvers<void>();
		kernel.kernelToolEvents.addEventListener(
			"nestedInvoke",
			() => {
				events.push("nestedInvoke");
				nested.resolve();
			},
			{ once: true },
		);
		const invoke = kernel.invokeKernelTool({
			name: "lookup",
			kernel_generation: descriptor.kernel_generation,
			definition_revision: descriptor.definition_revision,
			args: { path: "demo.txt" },
			call_id: "qa-child",
		});
		await bounded(nested.promise, "nestedInvoke");
		const readCall = await bounded(kernel.nextToolCall(), "nested-read");
		assert.equal(readCall.toolName, "read");
		assert.notEqual(readCall.callId, agentCall.callId);
		events.push("hostBridge");
		kernel.deliverToolReply({ type: "tool-reply", callId: readCall.callId, ok: true, value: "nested-body" });
		assert.equal(await bounded(invoke, "lookup-result"), "nested-body");
		events.push("childFinished");
		kernel.deliverToolReply({ type: "tool-reply", callId: agentCall.callId, ok: true, value: { text: "child-done" } });
		const result = await bounded(run, "parent-result");
		assert.equal(result.ok, true);
		assert.equal(result.ok ? result.valueRepr : undefined, '"child-done"');
		events.push("parentFinished");
		return { events, kernelMode: kernel.mode, descriptor };
	});
}

async function workerResetAbortAndRecursion() {
	return await withKernel(async (kernel) => {
		const run = kernel.run({
			cellId: "qa-reset",
			code: "tool(async function lookup(path) { return await tool.read({ path }); }); tool(async function bad() { return await agent('nope'); }); await tool.hold({}); return 1;",
			timeoutMs: FENCE_MS,
		});
		await bounded(kernel.nextToolCall(), "hold");
		const described = await kernel.describeKernelTools(["lookup", "bad"]);
		const lookup = described.results[0]?.ok ? described.results[0].descriptor : undefined;
		const bad = described.results[1]?.ok ? described.results[1].descriptor : undefined;
		assert(lookup && bad);
		let recursion = "";
		try {
			await kernel.invokeKernelTool({
				name: "bad",
				kernel_generation: bad.kernel_generation,
				definition_revision: bad.definition_revision,
				args: {},
				call_id: "qa-recursion",
			});
		} catch (error) {
			recursion = error instanceof Error && "code" in error ? String(error.code) : "unknown";
		}
		assert.equal(recursion, "kernel_tool_recursion");
		const pending = kernel.invokeKernelTool({
			name: "lookup",
			kernel_generation: lookup.kernel_generation,
			definition_revision: lookup.definition_revision,
			args: { path: "x" },
			call_id: "qa-stale",
		});
		const staleResult = pending.then(
			() => {
				throw new Error("pending invoke settled");
			},
			(error: unknown) => error,
		);
		await bounded(kernel.nextToolCall(), "pending-read");
		await kernel.reset();
		const staleError = await bounded(staleResult, "stale-result");
		const stale = staleError instanceof Error && "code" in staleError ? String(staleError.code) : "unknown";
		assert.equal(stale, "kernel_tool_stale");
		void run;
		return { recursion, stale, kernelMode: kernel.mode };
	});
}

const args = parseArgs({
	args: process.argv.slice(2),
	options: {
		case: { type: "string" },
		out: { type: "string" },
	},
});
const name = args.values.case;
const out = args.values.out;
if (!name || !out) {
	console.error("usage: omp-item6.ts --case <case> --out <path>");
	process.exit(2);
}

const payload =
	name === "worker-parent-awaits-child"
		? { case: name, passed: true, ...(await workerParentAwaitsChild()) }
		: name === "worker-reset-abort-and-recursion"
			? { case: name, passed: true, ...(await workerResetAbortAndRecursion()) }
			: null;
if (!payload) {
	console.error(`unknown case: ${name}`);
	process.exit(2);
}
await mkdir(dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify(payload, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, case: name, out }));
