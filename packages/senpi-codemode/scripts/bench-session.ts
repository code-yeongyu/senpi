import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentToolResult } from "@code-yeongyu/senpi";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";
import type { CodemodeMemorySettings } from "../src/config/memory-settings.ts";
import type { EvalKernel, EvalLanguage } from "../src/tool/types.ts";
import { BenchAccountingError, instrumentInterpreter, watchExitUsage } from "./bench-accounting.ts";
import { cpuProbeCell } from "./bench-cells.ts";
import { readInterpreterCpuUs } from "./bench-process-cpu.ts";

export interface KernelCpu {
	readonly pid: number;
	readonly cpuUs: number;
}

export type BenchMemory = Pick<CodemodeMemorySettings, "gcWatermarkMb" | "noticeMb" | "ceilingMb">;

export interface CellOutcome {
	readonly text: string;
	readonly wallMs: number;
}

export interface BenchSession {
	readonly JavaScriptKernel: Modules["jsKernel"]["JavaScriptKernel"];
	readonly language: EvalLanguage;
	readonly artifactsDir: string;
	readonly fixturePath: string;
	readonly toolCalls: () => number;
	kernel(listener?: (message: KernelToHostMessage) => void): Promise<EvalKernel>;
	cell(code: string): Promise<CellOutcome>;
	detach(cellId: string, code: string): Promise<string>;
	stopDetached(cellId: string): Promise<void>;
	probe(): Promise<KernelCpu>;
	cpu(probeLive?: boolean): Promise<readonly KernelCpu[]>;
	dispose(): Promise<void>;
}

type Modules = {
	readonly jsKernel: typeof import("../src/kernels/js/context-manager.ts");
	readonly sessions: typeof import("../src/extension/session-manager.ts");
	readonly settings: typeof import("../src/config/settings.ts");
	readonly detect: typeof import("../src/interpreters/detect.ts");
	readonly tools: typeof import("../src/tool/eval-tool.ts");
	readonly cells: typeof import("../src/tool/detached-cell-manager.ts");
	readonly fakes: typeof import("../test/eval/fakes.ts");
};

/**
 * The compared code is the target checkout's own source, loaded by absolute path; a static import would
 * measure the bench's checkout on both sides. Imports finish before any measurement window opens.
 */
export async function loadTarget(target: string): Promise<Modules> {
	const url = (path: string): string => pathToFileURL(join(target, path)).href;
	const sessions: Modules["sessions"] = await import(url("src/extension/session-manager.ts"));
	const settings: Modules["settings"] = await import(url("src/config/settings.ts"));
	const detect: Modules["detect"] = await import(url("src/interpreters/detect.ts"));
	const tools: Modules["tools"] = await import(url("src/tool/eval-tool.ts"));
	const cells: Modules["cells"] = await import(url("src/tool/detached-cell-manager.ts"));
	const fakes: Modules["fakes"] = await import(url("test/eval/fakes.ts"));
	const jsKernel: Modules["jsKernel"] = await import(url("src/kernels/js/context-manager.ts"));
	return { sessions, settings, detect, tools, cells, fakes, jsKernel };
}

function textResult(text: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details: {} };
}

function textOf(result: AgentToolResult<unknown>): string {
	return result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

function field(params: unknown, name: string): unknown {
	return typeof params === "object" && params !== null && name in params ? Reflect.get(params, name) : undefined;
}

/** Deterministic host tools: `read` returns the file it names, `echo` returns `item-<n>`. */
async function benchTool(toolName: string, params: unknown): Promise<AgentToolResult<unknown>> {
	const path = field(params, "path");
	if (toolName === "read" && typeof path === "string") return textResult(await readFile(path, "utf8"));
	if (toolName === "echo") return textResult(`item-${String(field(params, "n"))}`);
	throw new Error(`bench tool ${toolName} is not defined`);
}

export async function createBenchSession(
	modules: Modules,
	language: EvalLanguage,
	memory?: BenchMemory,
): Promise<BenchSession> {
	const root = await mkdtemp(join(tmpdir(), "senpi-codemode-bench-"));
	const artifactsDir = join(root, "artifacts");
	const fixturePath = join(root, "fixture-1kib.txt");
	await writeFile(fixturePath, "x".repeat(1023) + "\n");
	let calls = 0;
	const executeTool = async (toolName: string, params: unknown): Promise<AgentToolResult<unknown>> => {
		calls += 1;
		return await benchTool(toolName, params);
	};
	const { defaultCodemodeSettings } = modules.settings;
	const settings = {
		...defaultCodemodeSettings,
		memory: { ...defaultCodemodeSettings.memory, ...memory },
		languages: { js: false, py: true, rb: false, jl: false, [language]: true },
	};
	const detected = await modules.detect.getInterpreterAvailability(
		settings,
		modules.detect.createInterpreterDetector(),
	);
	const availability = await instrumentInterpreter(detected, { root, language });
	const accounting = await watchExitUsage(root);
	const manager = await modules.sessions.createCodemodeSessionManager({
		sessionId: `bench-${crypto.randomUUID()}`,
		cwd: root,
		settings,
		availability,
		artifactsDir,
		executeTool,
		complete: async () => {
			throw new Error("the bench defines no completion");
		},
	});
	const enabledLanguages = { js: false, py: false, rb: false, jl: false, [language]: true };
	const common = { enabledLanguages, kernelManager: manager, executeTool, settings, artifactsDir };
	const evalTool = modules.tools.createEvalTool({ ...common, cellTimeoutSeconds: settings.cellTimeoutSeconds });
	const detachCells = new modules.cells.EvalDetachedCellManager({ artifactsDir });
	const detachTool = modules.tools.createEvalTool({ ...common, cellTimeoutSeconds: 1, cellManager: detachCells });
	const ctx = { ...modules.fakes.fakeExtensionContext(), cwd: root, mode: "tui" as const };
	let sequence = 0;
	const session: BenchSession = {
		JavaScriptKernel: modules.jsKernel.JavaScriptKernel,
		language,
		artifactsDir,
		fixturePath,
		toolCalls: () => calls,
		kernel: async (listener) => await manager.getKernel(language, listener ?? (() => {})),
		async cell(code) {
			sequence += 1;
			const started = performance.now();
			const result = await evalTool.execute(
				`bench-${sequence}`,
				{ language, code, summary: "bench" },
				undefined,
				undefined,
				ctx,
			);
			const wallMs = performance.now() - started;
			if (result.details?.isError === true) throw new Error(`bench cell failed: ${textOf(result).slice(0, 400)}`);
			return { text: textOf(result), wallMs };
		},
		async detach(cellId, code) {
			const params = { language, code, summary: "bench detach", on_timeout: "detach" as const };
			return textOf(await detachTool.execute(cellId, params, undefined, undefined, ctx));
		},
		async stopDetached(cellId) {
			await detachCells.stop(cellId);
			await detachCells.flushNotifications();
		},
		async probe() {
			if (language === "js") return { pid: process.pid, cpuUs: 0 };
			const kernel = await session.kernel();
			sequence += 1;
			const result = await kernel.run({
				cellId: `bench-probe-${sequence}`,
				code: cpuProbeCell[language],
				timeoutMs: 60_000,
			});
			const match = result.ok ? /(\d+)\D+(\d+)/u.exec(result.valueRepr ?? "") : null;
			if (!match) throw new Error(`bench cpu probe failed: ${result.ok ? result.valueRepr : result.error.message}`);
			const python = detected.py.detected;
			if (!python.ok) throw new BenchAccountingError("live CPU accounting needs Python");
			const pid = Number(match[1]);
			// run() resolves after the complete result arrives; its embedded clock preceded encoding.
			return { pid, cpuUs: readInterpreterCpuUs(pid, python.resolvedPath ?? python.path) };
		},
		async cpu(probeLive = true) {
			if (language === "js") return [];
			return await accounting.totals(probeLive ? await session.probe() : undefined);
		},
		async dispose() {
			await manager.dispose();
			await accounting.totals();
			accounting.close();
			await rm(root, { recursive: true, force: true });
		},
	};
	return session;
}
