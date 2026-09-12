import type { AgentToolResult, ExtensionContext } from "@code-yeongyu/senpi";
import { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";
import { EvalDetachedCellManager } from "../src/tool/detached-cell-manager.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import type { EvalToolDetails } from "../src/tool/types.ts";

class QaScenarioError extends Error {
	readonly name = "QaScenarioError";
}

const BLOCKED_STOP_BUDGET_MS = 5_000;
const BLOCKED_HOLD_MS = 12_000;
const runtime = Reflect.has(globalThis, "Bun") ? "bun" : "node";

function textOf(result: AgentToolResult<EvalToolDetails>): string {
	return result.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.filter(Boolean)
		.join("\n");
}

function requireMatch(label: string, text: string, pattern: RegExp): void {
	if (!pattern.test(text)) throw new QaScenarioError(`${label}: expected ${pattern} in:\n${text}`);
}

const kernel = new JavaScriptKernel({
	sessionId: `qa-js-interrupt-${crypto.randomUUID()}`,
	cwd: process.cwd(),
	parallelPoolWidth: 2,
});
const cellManager = new EvalDetachedCellManager({});
const tool = createEvalTool({
	enabledLanguages: { js: true, py: false, rb: false, jl: false },
	kernelManager: { getKernel: async () => kernel },
	cellTimeoutSeconds: 1,
	// The only bridge tool never answers, so a cell awaiting it can settle solely through interrupt.
	executeTool: (async () => await new Promise<never>(() => {})) as never,
	cellManager,
});
const ctx = { mode: "tui", hasUI: true, cwd: process.cwd() } as unknown as ExtensionContext;
const report: Record<string, unknown> = { runtime };

try {
	const timeout = await tool
		.execute(
			"qa-timeout",
			{
				language: "js",
				code: "globalThis.qaTimeoutMarker = 42; return await tool.never({})",
				on_timeout: "error",
				timeout: 1,
				summary: "Await a bridge call that never answers under a 1s timeout",
			},
			undefined,
			undefined,
			ctx,
		)
		.then(() => "UNEXPECTED-SUCCESS", (error: Error) => `${error.name}: ${error.message}`);
	report.timeout = timeout;
	requireMatch("timeout", timeout, /TimeoutError/u);
	requireMatch("timeout state", timeout, /remains running|preserved/iu);
	const timeoutReadback = await kernel.run({ cellId: "qa-timeout-readback", code: "qaTimeoutMarker", timeoutMs: 5_000 });
	report.timeoutReadback = timeoutReadback;
	if (!timeoutReadback.ok || timeoutReadback.valueRepr !== "42")
		throw new QaScenarioError(`state did not survive the timeout: ${JSON.stringify(timeoutReadback)}`);

	const detached = await tool.execute(
		"qa-detached",
		{
			language: "js",
			code: "globalThis.qaStopMarker = 7; return await tool.never({})",
			on_timeout: "detach",
			timeout: 1,
			summary: "Detach on a bridge call that never answers",
		},
		undefined,
		undefined,
		ctx,
	);
	requireMatch("detach", textOf(detached), /detached/u);
	const stopped = await tool.execute("qa-stop", { action: "stop", cell_id: "qa-detached" }, undefined, undefined, ctx);
	report.stop = textOf(stopped);
	requireMatch("stop state", textOf(stopped), /remains running|preserved/iu);
	const stopReadback = await kernel.run({ cellId: "qa-stop-readback", code: "qaStopMarker", timeoutMs: 5_000 });
	report.stopReadback = stopReadback;
	if (!stopReadback.ok || stopReadback.valueRepr !== "7")
		throw new QaScenarioError(`state did not survive the stop: ${JSON.stringify(stopReadback)}`);

	const holdScript = `setTimeout(() => {}, ${BLOCKED_HOLD_MS})`;
	const blocked = await tool.execute(
		"qa-blocked",
		{
			language: "js",
			code: [
				'const { spawnSync } = await import("node:child_process");',
				"globalThis.qaBlockedMarker = 1;",
				`spawnSync(process.execPath, ["-e", ${JSON.stringify(holdScript)}]);`,
				'return "unblocked";',
			].join("\n"),
			on_timeout: "detach",
			timeout: 1,
			summary: "Block the worker in spawnSync, then detach",
		},
		undefined,
		undefined,
		ctx,
	);
	requireMatch("blocked detach", textOf(blocked), /detached/u);
	const stopStartedAt = performance.now();
	const blockedStop = await tool.execute("qa-blocked-stop", { action: "stop", cell_id: "qa-blocked" }, undefined, undefined, ctx);
	const stopMs = performance.now() - stopStartedAt;
	report.blockedStop = textOf(blockedStop);
	report.blockedStopMs = stopMs;
	await cellManager.flushNotifications();
	const snapshot = cellManager.peek("qa-blocked");
	report.blockedSnapshot = { state: snapshot.state, stateRetained: snapshot.stateRetained, outputTail: snapshot.outputTail };
	if (stopMs >= BLOCKED_STOP_BUDGET_MS) throw new QaScenarioError(`blocked stop took ${stopMs}ms`);
	requireMatch("blocked stop state", textOf(blockedStop), /restarted|lost/iu);
	requireMatch("blocked stop note", textOf(blockedStop), /synchronous/iu);
	const fresh = await kernel.run({ cellId: "qa-blocked-readback", code: "typeof qaBlockedMarker", timeoutMs: 5_000 });
	report.blockedReadback = fresh;
	if (!fresh.ok || fresh.valueRepr !== '"undefined"')
		throw new QaScenarioError(`fresh worker did not serve the next cell: ${JSON.stringify(fresh)}`);

	console.log(JSON.stringify({ ok: true, ...report }, null, 2));
} finally {
	await cellManager.dispose();
	await kernel.close();
}
