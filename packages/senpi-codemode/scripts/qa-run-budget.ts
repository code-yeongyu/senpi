import type { AgentToolResult, ExtensionContext } from "@code-yeongyu/senpi";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";
import { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";
import { EvalDetachedCellManager, type EvalDetachedCellNotification } from "../src/tool/detached-cell-manager.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import type { EvalToolDetails } from "../src/tool/types.ts";

class QaScenarioError extends Error {
	readonly name = "QaScenarioError";
}

const RUN_BUDGET_SECONDS = 2;
const PARKED_BRIDGE_MS = 4_000;
const KILL_WINDOW_MS = 4_500;
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

function requireWithin(label: string, elapsedMs: number, minMs: number, maxMs: number): void {
	if (elapsedMs < minMs || elapsedMs > maxMs)
		throw new QaScenarioError(`${label}: took ${Math.round(elapsedMs)}ms, expected ${minMs}-${maxMs}ms`);
}

class Notifications {
	readonly received: EvalDetachedCellNotification[] = [];

	notify(cells: readonly EvalDetachedCellNotification[]): void {
		this.received.push(...cells);
	}
}

let deliver: ((message: KernelToHostMessage) => void) | undefined;
const kernel = new JavaScriptKernel({
	sessionId: `qa-run-budget-${crypto.randomUUID()}`,
	cwd: process.cwd(),
	parallelPoolWidth: 2,
	onMessage: (message) => deliver?.(message),
});
const notifications = new Notifications();
const cellManager = new EvalDetachedCellManager({
	runBudgetSeconds: RUN_BUDGET_SECONDS,
	hardLimitSeconds: 120,
	notifier: notifications,
});
const tool = createEvalTool({
	enabledLanguages: { js: true, py: false, rb: false, jl: false },
	kernelManager: {
		getKernel: async (_language, onMessage) => {
			deliver = onMessage;
			return kernel;
		},
	},
	cellTimeoutSeconds: 1,
	runBudgetSeconds: RUN_BUDGET_SECONDS,
	hardLimitSeconds: 120,
	// The only bridge tool answers after a real 4s wait, longer than the whole run budget.
	executeTool: (async () => {
		await new Promise((resolve) => setTimeout(resolve, PARKED_BRIDGE_MS));
		return { content: [{ type: "text", text: "slow bridge value" }], details: {} };
	}) as never,
	cellManager,
});
const printContext = { mode: "print", hasUI: false, cwd: process.cwd() } as unknown as ExtensionContext;
const interactiveContext = { mode: "tui", hasUI: true, cwd: process.cwd() } as unknown as ExtensionContext;
const report: Record<string, unknown> = { runtime, runBudgetSeconds: RUN_BUDGET_SECONDS, startedAt: new Date().toISOString() };

try {
	const parkedStartedAt = performance.now();
	const parked = await tool.execute(
		"qa-parked",
		{
			language: "js",
			code: "globalThis.qaParkedMarker = 3; return await tool.slow({})",
			summary: "Park on a 4s bridge call under a 2s run budget",
		},
		undefined,
		undefined,
		printContext,
	);
	const parkedMs = performance.now() - parkedStartedAt;
	report.parked = { text: textOf(parked), elapsedMs: Math.round(parkedMs) };
	requireMatch("parked value", textOf(parked), /slow bridge value/u);
	requireWithin("parked elapsed", parkedMs, PARKED_BRIDGE_MS - 100, PARKED_BRIDGE_MS + KILL_WINDOW_MS);

	const killStartedAt = performance.now();
	const killed = await tool
		.execute(
			"qa-budget-kill",
			{
				language: "js",
				code: "globalThis.qaKillMarker = 5; await new Promise((resolve) => setTimeout(resolve, 20_000)); return 'late'",
				summary: "Sleep 20s of own time under a 2s run budget",
			},
			undefined,
			undefined,
			printContext,
		)
		.then(() => "UNEXPECTED-SUCCESS", (error: Error) => `${error.name}: ${error.message}`);
	const killMs = performance.now() - killStartedAt;
	report.killed = { text: killed, elapsedMs: Math.round(killMs) };
	requireMatch("kill error", killed, /TimeoutError/u);
	requireMatch("kill names budget", killed, /2s run budget/u);
	requireWithin("kill elapsed", killMs, RUN_BUDGET_SECONDS * 1_000 - 50, RUN_BUDGET_SECONDS * 1_000 + KILL_WINDOW_MS);
	const killReadback = await kernel.run({ cellId: "qa-kill-readback", code: "typeof qaKillMarker", timeoutMs: 5_000 });
	report.killReadback = killReadback;

	if (runtime === "bun") {
		const shellStartedAt = performance.now();
		const shellKilled = await tool
			.execute(
				"qa-shell-kill",
				{
					language: "js",
					code: "return await Bun.$`sleep 20`.text()",
					summary: "Await a 20s Bun.$ child under a 2s run budget (the 2026-09-10 incident shape)",
				},
				undefined,
				undefined,
				printContext,
			)
			.then(() => "UNEXPECTED-SUCCESS", (error: Error) => `${error.name}: ${error.message}`);
		const shellMs = performance.now() - shellStartedAt;
		report.shellKilled = { text: shellKilled, elapsedMs: Math.round(shellMs) };
		requireMatch("shell kill error", shellKilled, /TimeoutError/u);
		requireMatch("shell kill names budget", shellKilled, /2s run budget/u);
		requireWithin("shell kill elapsed", shellMs, RUN_BUDGET_SECONDS * 1_000 - 50, RUN_BUDGET_SECONDS * 1_000 + KILL_WINDOW_MS);
	}

	const detachedStartedAt = performance.now();
	const detached = await tool.execute(
		"qa-detached-kill",
		{
			language: "js",
			code: "await new Promise((resolve) => setTimeout(resolve, 20_000)); return 'late'",
			on_timeout: "detach",
			summary: "Detach at 1s, then exhaust the 2s run budget in the background",
		},
		undefined,
		undefined,
		interactiveContext,
	);
	const detachMs = performance.now() - detachedStartedAt;
	requireMatch("detached", textOf(detached), /detached and is still running/u);
	requireWithin("detach elapsed", detachMs, 900, 2_500);
	const terminal = await cellManager.waitForTerminal("qa-detached-kill");
	const terminalMs = performance.now() - detachedStartedAt;
	await cellManager.flushNotifications();
	report.detached = {
		detachElapsedMs: Math.round(detachMs),
		terminalElapsedMs: Math.round(terminalMs),
		state: terminal.state,
		runBudgetSeconds: terminal.runBudgetSeconds,
		stateRetained: terminal.stateRetained,
		notification: notifications.received.map((item) => item.content),
	};
	if (terminal.state !== "cancelled" || terminal.runBudgetSeconds !== RUN_BUDGET_SECONDS)
		throw new QaScenarioError(`detached cell did not end on the run budget: ${JSON.stringify(terminal)}`);
	requireWithin("detached kill elapsed", terminalMs, RUN_BUDGET_SECONDS * 1_000 - 50, RUN_BUDGET_SECONDS * 1_000 + KILL_WINDOW_MS);
	requireMatch("notification", notifications.received.map((item) => item.content).join("\n"), /2s run budget/u);

	report.verdict = "PASS";
} catch (error) {
	report.verdict = "FAIL";
	report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
} finally {
	await kernel.close();
	report.finishedAt = new Date().toISOString();
	console.log(JSON.stringify(report, null, 2));
}
if (report.verdict !== "PASS") process.exit(1);
