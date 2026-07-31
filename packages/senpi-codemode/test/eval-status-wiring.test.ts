import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodemodeSessionManager } from "../src/extension/session-manager.ts";
import senpiCodemode, { type CodemodeExtensionAPI } from "../src/index.ts";
import type { EvalKernel } from "../src/tool/types.ts";
import { FakeKernel, fakeExtensionContext, result } from "./eval/fakes.ts";

interface StatusCall {
	readonly key: string;
	readonly text: string | undefined;
}

class WiringPi {
	readonly handlers: Array<{
		readonly event: string;
		readonly handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void;
	}> = [];
	readonly messages: string[] = [];
	registeredTool: Parameters<CodemodeExtensionAPI["registerTool"]>[0] | undefined;

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

const artifactsRoot = join(tmpdir(), `senpi-codemode-status-wiring-${process.pid}`);
const directories: string[] = [];

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(directories.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
	await rm(artifactsRoot, { recursive: true, force: true });
});

async function sessionCwd(): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "senpi-codemode-status-"));
	directories.push(cwd);
	await mkdir(join(cwd, ".senpi"), { recursive: true });
	await writeFile(
		join(cwd, ".senpi", "codemode.json"),
		JSON.stringify({ languages: { py: false, js: true, rb: false, jl: false }, cellTimeoutSeconds: 1 }),
	);
	return cwd;
}

function wiringContext(cwd: string, mode: "tui" | "rpc", calls: StatusCall[], themeCalls: string[]): ExtensionContext {
	const base = fakeExtensionContext();
	// Object.create(null) keeps the fake structurally typed like fakeExtensionContext()'s ui,
	// so only the members the status wiring touches need to exist.
	const theme = Object.create(null);
	theme.fg = (color: string, text: string): string => {
		themeCalls.push(`fg:${color}`);
		return text;
	};
	theme.bg = (color: string, text: string): string => {
		themeCalls.push(`bg:${color}`);
		return text;
	};
	const ui = Object.create(null);
	ui.setStatus = (key: string, text: string | undefined): void => {
		calls.push({ key, text });
	};
	ui.theme = theme;
	const sessionManager = Object.create(null);
	sessionManager.getSessionFile = (): string => join(artifactsRoot, `${crypto.randomUUID()}.jsonl`);
	return { ...base, cwd, mode, hasUI: true, ui, sessionManager };
}

async function detachOne(
	pi: WiringPi,
	kernel: FakeKernel,
	ctx: ExtensionContext,
	cellId: string,
	title: string,
): Promise<void> {
	const tool = pi.registeredTool;
	if (!tool) throw new Error("eval tool was not registered");
	const started = kernel.deferNextRun();
	const execution = tool.execute(
		cellId,
		{ language: "js", code: "await forever", title, on_timeout: "detach" },
		undefined,
		undefined,
		ctx,
	);
	await started;
	await vi.advanceTimersByTimeAsync(1_000);
	await execution;
}

describe("detached eval cell footer status wiring", () => {
	it("highlights the detached cell in the TUI footer and clears it on completion", async () => {
		const cwd = await sessionCwd();
		const pi = new WiringPi();
		const kernel = new FakeKernel([]);
		senpiCodemode(pi, { createSessionManager: () => new WiringSessionManager(kernel) });
		const calls: StatusCall[] = [];
		const themeCalls: string[] = [];
		const ctx = wiringContext(cwd, "tui", calls, themeCalls);
		await pi.emit("session_start", { reason: "startup" }, ctx);

		vi.useFakeTimers();
		await detachOne(pi, kernel, ctx, "wiring-cell", "wiring probe");

		expect(calls.at(-1)).toEqual({ key: "eval-cells", text: "↗ js · wiring probe (0s)" });
		expect(themeCalls).toContain("bg:selectedBg");
		expect(themeCalls).toContain("fg:text");

		kernel.completeDeferredRun(result("wiring-cell", "42"));
		await vi.waitFor(() => expect(calls.at(-1)).toEqual({ key: "eval-cells", text: undefined }));

		await pi.emit("session_shutdown", {}, ctx);
	});

	it("sets a plain status outside the TUI", async () => {
		const cwd = await sessionCwd();
		const pi = new WiringPi();
		const kernel = new FakeKernel([]);
		senpiCodemode(pi, { createSessionManager: () => new WiringSessionManager(kernel) });
		const calls: StatusCall[] = [];
		const themeCalls: string[] = [];
		const ctx = wiringContext(cwd, "rpc", calls, themeCalls);
		await pi.emit("session_start", { reason: "startup" }, ctx);

		vi.useFakeTimers();
		await detachOne(pi, kernel, ctx, "rpc-cell", "rpc probe");

		expect(calls.at(-1)).toEqual({ key: "eval-cells", text: "↗ js · rpc probe (0s)" });
		expect(themeCalls).toEqual([]);

		kernel.completeDeferredRun(result("rpc-cell", "7"));
		await vi.waitFor(() => expect(calls.at(-1)).toEqual({ key: "eval-cells", text: undefined }));

		await pi.emit("session_shutdown", {}, ctx);
	});

	it("advances the elapsed label while the cell stays detached", async () => {
		const cwd = await sessionCwd();
		const pi = new WiringPi();
		const kernel = new FakeKernel([]);
		vi.useFakeTimers();
		senpiCodemode(pi, { createSessionManager: () => new WiringSessionManager(kernel) });
		const calls: StatusCall[] = [];
		const themeCalls: string[] = [];
		const ctx = wiringContext(cwd, "rpc", calls, themeCalls);

		await pi.emit("session_start", { reason: "startup" }, ctx);
		// detachOne advances the fake clock by the 1s cell timeout, so the first
		// visible label is already one second in.
		await detachOne(pi, kernel, ctx, "tick-cell", "ticking probe");
		expect(calls.at(-1)).toEqual({ key: "eval-cells", text: "↗ js · ticking probe (1s)" });

		await vi.advanceTimersByTimeAsync(1_000);
		expect(calls.at(-1)).toEqual({ key: "eval-cells", text: "↗ js · ticking probe (2s)" });

		await vi.advanceTimersByTimeAsync(1_000);
		expect(calls.at(-1)).toEqual({ key: "eval-cells", text: "↗ js · ticking probe (3s)" });

		kernel.completeDeferredRun(result("tick-cell", "9"));
		await vi.waitFor(() => expect(calls.at(-1)).toEqual({ key: "eval-cells", text: undefined }));

		await pi.emit("session_shutdown", {}, ctx);
	});
});
