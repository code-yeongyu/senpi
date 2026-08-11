import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodemodeSessionManager } from "../src/extension/session-manager.ts";
import { WAKE_SOURCE_STATE_EVENT, type WakeSourceState } from "../src/extension/wake-source-state.ts";
import senpiCodemode, { type CodemodeExtensionAPI } from "../src/index.ts";
import { EvalDetachedCellManager } from "../src/tool/detached-cell-manager.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import type { EvalKernel } from "../src/tool/types.ts";
import { FakeKernel, FakeManager, fakeExtensionContext, result } from "./eval/fakes.ts";

const directories: string[] = [];

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(directories.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
});

function wakeSourceRecorder(): {
	readonly emissions: WakeSourceState[];
	readonly onWakeSourceState: (state: WakeSourceState) => void;
} {
	const emissions: WakeSourceState[] = [];
	return { emissions, onWakeSourceState: (state) => emissions.push(state) };
}

function interactiveContext() {
	return { ...fakeExtensionContext(), mode: "tui" as const };
}

function createTool(manager: EvalDetachedCellManager, entries: Array<readonly [string, FakeKernel]>) {
	return createEvalTool({
		enabledLanguages: { js: true, py: true, rb: false, jl: false },
		kernelManager: new FakeManager(entries),
		cellTimeoutSeconds: 1,
		executeTool: vi.fn(),
		cellManager: manager,
	});
}

async function detach(
	tool: ReturnType<typeof createTool>,
	kernel: FakeKernel,
	cellId: string,
	summary: string,
	language: "js" | "py" = "js",
): Promise<void> {
	const started = kernel.deferNextRun();
	const execution = tool.execute(
		cellId,
		{ language, code: "await forever", summary, on_timeout: "detach" },
		undefined,
		undefined,
		interactiveContext(),
	);
	await started;
	await vi.advanceTimersByTimeAsync(1_000);
	await execution;
}

describe("eval detached cell wake source liveness", () => {
	it("emits a full snapshot with the channel entry when one cell detaches", async () => {
		vi.useFakeTimers();
		const channel = wakeSourceRecorder();
		const manager = new EvalDetachedCellManager({ onWakeSourceState: channel.onWakeSourceState });
		const kernel = new FakeKernel([]);
		const tool = createTool(manager, [["js", kernel]]);

		await detach(tool, kernel, "channel-cell", "numpy feather rerun");

		expect(channel.emissions).toEqual([
			{
				source: "senpi-codemode",
				activeCount: 1,
				items: [{ id: "channel-cell", description: "numpy feather rerun", startedAtMs: expect.any(Number) }],
			},
		]);
		await manager.stop("channel-cell");
		await manager.flushNotifications();
	});

	it("tracks activeCount as two live cells settle one by one", async () => {
		vi.useFakeTimers();
		const channel = wakeSourceRecorder();
		const manager = new EvalDetachedCellManager({ onWakeSourceState: channel.onWakeSourceState });
		const js = new FakeKernel([]);
		const py = new FakeKernel([]);
		const tool = createTool(manager, [
			["js", js],
			["py", py],
		]);

		await detach(tool, js, "js-cell", "bundle build", "js");
		await detach(tool, py, "py-cell", "strip repairs", "py");

		expect(channel.emissions.at(-1)).toEqual({
			source: "senpi-codemode",
			activeCount: 2,
			items: [
				{ id: "js-cell", description: "bundle build", startedAtMs: expect.any(Number) },
				{ id: "py-cell", description: "strip repairs", startedAtMs: expect.any(Number) },
			],
		});

		await manager.stop("js-cell");

		expect(channel.emissions.at(-1)).toEqual({
			source: "senpi-codemode",
			activeCount: 1,
			items: [{ id: "py-cell", description: "strip repairs", startedAtMs: expect.any(Number) }],
		});

		await manager.stop("py-cell");

		expect(channel.emissions.at(-1)).toEqual({ source: "senpi-codemode", activeCount: 0, items: [] });
		await manager.flushNotifications();
	});
});

interface StatusCall {
	readonly key: string;
	readonly text: string | undefined;
}

interface BusEmission {
	readonly name: string;
	readonly data: unknown;
}

class WiringPi {
	readonly handlers: Array<{
		readonly event: string;
		readonly handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void;
	}> = [];
	readonly messages: string[] = [];
	registeredTool: Parameters<CodemodeExtensionAPI["registerTool"]>[0] | undefined;
	events?: { emit(name: string, data: unknown): void };

	registerTool(tool: Parameters<CodemodeExtensionAPI["registerTool"]>[0]): void {
		if (tool.name === "eval") this.registeredTool = tool;
	}
	registerRemovedToolHint(): void {}
	on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void): void {
		this.handlers.push({ event, handler });
	}
	getActiveTools(): string[] {
		return ["eval"];
	}
	getAllTools(): readonly { readonly name: string }[] {
		return [{ name: "eval" }];
	}
	async executeTool(): Promise<never> {
		throw new Error("nested tool execution was not expected");
	}
	sendUserMessage(content: string): void {
		this.messages.push(content);
	}
	async emit(event: string, payload: unknown, ctx: ExtensionContext): Promise<void> {
		for (const entry of this.handlers.filter((handler) => handler.event === event)) await entry.handler(payload, ctx);
	}
}

class WiringSessionManager implements CodemodeSessionManager {
	readonly kernel: FakeKernel;

	constructor(kernel: FakeKernel) {
		this.kernel = kernel;
	}
	async getKernel(): Promise<EvalKernel> {
		return this.kernel;
	}
	async dispose(): Promise<void> {}
	async complete(): Promise<{
		readonly text: string;
		readonly details: { readonly model: string; readonly structured: false };
	}> {
		return { text: "ok", details: { model: "fake/fake-model", structured: false } };
	}
}

const artifactsRoot = join(tmpdir(), `senpi-codemode-channel-wiring-${process.pid}`);

afterEach(async () => {
	await rm(artifactsRoot, { recursive: true, force: true });
});

async function sessionCwd(): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "senpi-codemode-channel-"));
	directories.push(cwd);
	await mkdir(join(cwd, ".senpi"), { recursive: true });
	await writeFile(
		join(cwd, ".senpi", "codemode.json"),
		JSON.stringify({ languages: { py: false, js: true, rb: false, jl: false }, cellTimeoutSeconds: 1 }),
	);
	return cwd;
}

function wiringContext(cwd: string, calls: StatusCall[]): ExtensionContext {
	const base = fakeExtensionContext();
	const theme = Object.create(null);
	theme.fg = (_color: string, text: string): string => text;
	theme.bg = (_color: string, text: string): string => text;
	const ui = Object.create(null);
	ui.setStatus = (key: string, text: string | undefined): void => {
		calls.push({ key, text });
	};
	ui.theme = theme;
	const sessionManager = Object.create(null);
	sessionManager.getSessionFile = (): string => join(artifactsRoot, `${crypto.randomUUID()}.jsonl`);
	return { ...base, cwd, mode: "tui", hasUI: true, ui, sessionManager };
}

async function detachOne(
	pi: WiringPi,
	kernel: FakeKernel,
	ctx: ExtensionContext,
	cellId: string,
	summary: string,
): Promise<void> {
	const tool = pi.registeredTool;
	if (!tool) throw new Error("eval tool was not registered");
	const started = kernel.deferNextRun();
	const execution = tool.execute(
		cellId,
		{ language: "js", code: "await forever", summary, on_timeout: "detach" },
		undefined,
		undefined,
		ctx,
	);
	await started;
	await vi.advanceTimersByTimeAsync(1_000);
	await execution;
}

describe("wake source liveness wiring", () => {
	it("re-emits the current snapshot on session_start and publishes detach transitions on the host bus", async () => {
		const cwd = await sessionCwd();
		const pi = new WiringPi();
		const busEmissions: BusEmission[] = [];
		pi.events = { emit: (name, data) => busEmissions.push({ name, data }) };
		const kernel = new FakeKernel([]);
		senpiCodemode(pi, { createSessionManager: () => new WiringSessionManager(kernel) });
		const calls: StatusCall[] = [];
		const ctx = wiringContext(cwd, calls);

		await pi.emit("session_start", { reason: "startup" }, ctx);

		expect(busEmissions).toEqual([
			{
				name: "wake_source_state",
				data: { source: "senpi-codemode", activeCount: 0, items: [] },
			},
		]);

		vi.useFakeTimers();
		await detachOne(pi, kernel, ctx, "wire-cell", "wire probe");

		expect(busEmissions.at(-1)).toEqual({
			name: "wake_source_state",
			data: {
				source: "senpi-codemode",
				activeCount: 1,
				items: [{ id: "wire-cell", description: "wire probe", startedAtMs: expect.any(Number) }],
			},
		});

		kernel.completeDeferredRun(result("wire-cell", "42"));
		await vi.waitFor(() =>
			expect(busEmissions.at(-1)).toEqual({
				name: "wake_source_state",
				data: { source: "senpi-codemode", activeCount: 0, items: [] },
			}),
		);

		await pi.emit("session_shutdown", {}, ctx);
	});

	it("keeps the cell lifecycle intact when the host has no event bus", async () => {
		const cwd = await sessionCwd();
		const pi = new WiringPi();
		const kernel = new FakeKernel([]);
		senpiCodemode(pi, { createSessionManager: () => new WiringSessionManager(kernel) });
		const calls: StatusCall[] = [];
		const ctx = wiringContext(cwd, calls);
		await pi.emit("session_start", { reason: "startup" }, ctx);

		vi.useFakeTimers();
		await detachOne(pi, kernel, ctx, "busless-cell", "busless probe");

		expect(calls.at(-1)).toEqual({ key: "eval-cells", text: "↗ js · busless probe (0s)" });

		kernel.completeDeferredRun(result("busless-cell", "7"));
		await vi.waitFor(() => expect(calls.at(-1)).toEqual({ key: "eval-cells", text: undefined }));

		await pi.emit("session_shutdown", {}, ctx);
	});
});

describe("wake source event contract", () => {
	it("pins the duplicated event literal to the exact cross-package contract", () => {
		expect(WAKE_SOURCE_STATE_EVENT).toBe("wake_source_state");
	});
});
