import type { ExtensionContext } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodemodeSessionManager } from "../src/extension/session-manager.ts";
import senpiCodemode, { type CodemodeExtensionAPI } from "../src/index.ts";
import type { EvalKernelResult, EvalKernelRunInput } from "../src/tool/types.ts";
import { fakeExtensionContext } from "./eval/fakes.ts";

interface RegisteredHandler {
	readonly event: string;
	readonly handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void;
}

class FakePi {
	readonly tools: string[] = [];
	readonly handlers: RegisteredHandler[] = [];
	registeredTool: Pick<Parameters<CodemodeExtensionAPI["registerTool"]>[0], "execute"> | undefined;
	registerTool(tool: Parameters<CodemodeExtensionAPI["registerTool"]>[0]): void {
		this.tools.push(tool.name);
		if (tool.name === "eval") this.registeredTool = tool;
	}
	on(event: string, handler: RegisteredHandler["handler"]): void {
		this.handlers.push({ event, handler });
	}
	async executeTool(): Promise<never> {
		throw new Error("nested tool execution was not expected");
	}
}

class DisposableManager implements CodemodeSessionManager {
	readonly runControllers: AbortController[] = [];
	readonly runStarted = Promise.withResolvers<void>();
	#disposed = false;
	disposeCount = 0;
	getKernelCount = 0;
	async getKernel(): Promise<{
		run(input: EvalKernelRunInput): Promise<EvalKernelResult>;
		interrupt(): Promise<void>;
		deliverToolReply(): void;
		reset(): Promise<void>;
		close(): Promise<void>;
	}> {
		if (this.#disposed) throw new Error("manager disposed");
		this.getKernelCount++;
		const controller = new AbortController();
		this.runControllers.push(controller);
		return {
			run: async (input) => {
				this.runStarted.resolve();
				return await new Promise((resolve) => {
					controller.signal.addEventListener(
						"abort",
						() =>
							resolve({
								type: "result",
								cellId: input.cellId,
								ok: false,
								error: { message: "kernel disposed" },
								durationMs: 0,
							}),
						{ once: true },
					);
				});
			},
			interrupt: async () => undefined,
			deliverToolReply: () => undefined,
			reset: async () => undefined,
			close: async () => undefined,
		};
	}
	async dispose(): Promise<void> {
		this.#disposed = true;
		this.disposeCount++;
		for (const controller of this.runControllers) controller.abort();
	}
	async complete(): Promise<{
		readonly text: string;
		readonly details: { readonly model: string; readonly structured: false };
	}> {
		return { text: "ok", details: { model: "fake/fake-model", structured: false } };
	}
}

async function emit(pi: FakePi, event: string, payload: unknown, ctx: ExtensionContext): Promise<void> {
	for (const entry of pi.handlers.filter((handler) => handler.event === event)) {
		await entry.handler(payload, ctx);
	}
}

describe("senpi-codemode extension factory", () => {
	afterEach(() => vi.clearAllMocks());

	it("registers eval exactly once and has no module side effects", () => {
		const pi = new FakePi();
		const managers: DisposableManager[] = [];

		senpiCodemode(pi, {
			createSessionManager: () => {
				const manager = new DisposableManager();
				managers.push(manager);
				return manager;
			},
		});

		expect(pi.tools).toEqual(["eval"]);
		expect(managers).toEqual([]);
	});

	it("creates a fresh manager on start/reload and disposes on shutdown, switch, and fork", async () => {
		const pi = new FakePi();
		const managers: DisposableManager[] = [];
		senpiCodemode(pi, {
			createSessionManager: () => {
				const manager = new DisposableManager();
				managers.push(manager);
				return manager;
			},
		});
		const ctx = fakeExtensionContext();

		await emit(pi, "session_start", { reason: "startup" }, ctx);
		await emit(pi, "session_start", { reason: "reload" }, ctx);
		await emit(pi, "session_before_switch", {}, ctx);
		await emit(pi, "session_start", { reason: "switch" }, ctx);
		await emit(pi, "session_before_fork", {}, ctx);
		await emit(pi, "session_start", { reason: "fork" }, ctx);
		await emit(pi, "session_shutdown", {}, ctx);

		expect(managers).toHaveLength(4);
		expect(managers.map((manager) => manager.disposeCount)).toEqual([1, 1, 1, 1]);
	});

	it("disposes a delayed startup manager instead of publishing it after shutdown", async () => {
		// Given
		const pi = new FakePi();
		const creation = Promise.withResolvers<CodemodeSessionManager>();
		const creationStarted = Promise.withResolvers<void>();
		const manager = new DisposableManager();
		senpiCodemode(pi, {
			createSessionManager: () => {
				creationStarted.resolve();
				return creation.promise;
			},
		});
		const ctx = fakeExtensionContext();
		const startup = emit(pi, "session_start", { reason: "startup" }, ctx);
		await creationStarted.promise;

		// When
		await emit(pi, "session_shutdown", {}, ctx);
		creation.resolve(manager);
		await startup;

		// Then
		expect(manager.disposeCount).toBe(1);
		const tool = pi.registeredTool;
		if (!tool) throw new Error("eval tool was not registered");
		await expect(
			tool.execute("after-shutdown", { language: "js", code: "1" }, undefined, undefined, ctx),
		).rejects.toThrow("session has not started");
		expect(manager.getKernelCount).toBe(0);
	});
});

describe("senpi-codemode extension lifecycle", () => {
	it("settles a mid-run cell as an error and rejects post-shutdown work", async () => {
		const pi = new FakePi();
		const manager = new DisposableManager();
		senpiCodemode(pi, { createSessionManager: () => manager });
		const ctx = fakeExtensionContext();
		await emit(pi, "session_start", { reason: "startup" }, ctx);
		const tool = pi.registeredTool;
		expect(tool).toBeDefined();
		const run = tool?.execute("cell-running", { language: "js", code: "await pending()" }, undefined, undefined, ctx);
		await manager.runStarted.promise;
		await emit(pi, "session_shutdown", {}, ctx);

		await expect(run).resolves.toMatchObject({ details: expect.objectContaining({ isError: true }) });
		await expect(
			tool?.execute("after-shutdown", { language: "js", code: "1" }, undefined, undefined, ctx),
		).rejects.toThrow("session has not started");
		expect(manager.disposeCount).toBe(1);
		expect(manager.getKernelCount).toBe(1);
		expect(manager.runControllers[0]?.signal.aborted).toBe(true);
	});
});
