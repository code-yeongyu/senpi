import type { ExtensionAPI, ExtensionContext } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCompletionHandler } from "../src/completion/handler.ts";
import type { CodemodeSessionManager } from "../src/extension/session-manager.ts";
import senpiCodemode from "../src/index.ts";
import type { EvalKernelRunInput } from "../src/tool/types.ts";

interface RegisteredHandler {
	readonly event: string;
	readonly handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void;
}

class FakePi {
	readonly tools: string[] = [];
	readonly handlers: RegisteredHandler[] = [];
	registeredTool: { execute: (...args: readonly unknown[]) => Promise<unknown> } | undefined;
	registerTool(tool: { readonly name: string; execute?: (...args: readonly unknown[]) => Promise<unknown> }): void {
		this.tools.push(tool.name);
		if (tool.name === "eval" && tool.execute) this.registeredTool = { execute: tool.execute };
	}
	on(event: string, handler: RegisteredHandler["handler"]): void {
		this.handlers.push({ event, handler });
	}
}

class DisposableManager implements CodemodeSessionManager {
	readonly id: number;
	readonly runControllers: AbortController[] = [];
	readonly pendingRunResolvers: Array<() => void> = [];
	disposeCount = 0;
	constructor(id: number) {
		this.id = id;
	}
	async getKernel(): Promise<{
		run(input: EvalKernelRunInput): Promise<{ type: "result"; cellId: string; ok: true; durationMs: number }>;
		deliverToolReply(): void;
		reset(): Promise<void>;
		close(): Promise<void>;
	}> {
		const controller = new AbortController();
		this.runControllers.push(controller);
		return {
			run: async (input) =>
				await new Promise((resolve) => {
					this.pendingRunResolvers.push(() =>
						resolve({ type: "result", cellId: input.cellId, ok: true, durationMs: 0 }),
					);
				}),
			deliverToolReply: () => undefined,
			reset: async () => undefined,
			close: async () => undefined,
		};
	}
	async dispose(): Promise<void> {
		this.disposeCount++;
		for (const controller of this.runControllers) controller.abort();
		for (const resolve of this.pendingRunResolvers.splice(0)) resolve();
	}
	async complete(): Promise<{
		readonly text: string;
		readonly details: { readonly model: string; readonly structured: false };
	}> {
		return { text: "ok", details: { model: "fake/fake-model", structured: false } };
	}
}

const model = {
	id: "fake-model",
	name: "Fake Model",
	provider: "fake",
	api: "fake-api",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

type FakeModel = typeof model;
type FakeAssistantMessage = {
	readonly role: "assistant";
	readonly content: { readonly type: "text"; readonly text: string }[];
	readonly api: string;
	readonly provider: string;
	readonly model: string;
	readonly stopReason: "stop";
	readonly usage: {
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
		readonly totalTokens: number;
		readonly cost: {
			readonly input: number;
			readonly output: number;
			readonly cacheRead: number;
			readonly cacheWrite: number;
			readonly total: number;
		};
	};
	readonly timestamp: number;
};

function context(
	registry: { getApiKeyAndHeaders: (input: FakeModel) => Promise<unknown> },
	currentModel?: FakeModel | null,
): ExtensionContext {
	return {
		model: currentModel === undefined ? model : (currentModel ?? undefined),
		modelRegistry: registry,
		signal: undefined,
	} as unknown as ExtensionContext;
}

async function emit(pi: FakePi, event: string, payload: unknown, ctx: ExtensionContext): Promise<void> {
	for (const entry of pi.handlers.filter((handler) => handler.event === event)) {
		await entry.handler(payload, ctx);
	}
}

function textMessage(text: string): FakeAssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "fake-api",
		provider: "fake",
		model: "fake-model",
		stopReason: "stop",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

describe("senpi-codemode extension factory", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("registers eval exactly once and has no module side effects", () => {
		const pi = new FakePi();
		const managers: DisposableManager[] = [];

		senpiCodemode(pi as unknown as ExtensionAPI, {
			createSessionManager: () => {
				const manager = new DisposableManager(managers.length + 1);
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
		senpiCodemode(pi as unknown as ExtensionAPI, {
			createSessionManager: () => {
				const manager = new DisposableManager(managers.length + 1);
				managers.push(manager);
				return manager;
			},
		});
		const ctx = context({ getApiKeyAndHeaders: vi.fn() });

		await emit(pi, "session_start", { reason: "startup" }, ctx);
		await emit(pi, "session_start", { reason: "reload" }, ctx);
		await emit(pi, "session_before_switch", {}, ctx);
		await emit(pi, "session_start", { reason: "switch" }, ctx);
		await emit(pi, "session_before_fork", {}, ctx);
		await emit(pi, "session_start", { reason: "fork" }, ctx);
		await emit(pi, "session_shutdown", {}, ctx);

		expect(managers.map((manager) => manager.id)).toEqual([1, 2, 3, 4]);
		expect(managers.map((manager) => manager.disposeCount)).toEqual([1, 1, 1, 1]);
	});
});

describe("completion() handler", () => {
	it("uses ctx.model and ctx.modelRegistry credentials for text completion", async () => {
		const complete = vi.fn(async () => textMessage("done"));
		const registry = {
			getApiKeyAndHeaders: vi.fn(async () => ({
				ok: true,
				apiKey: "runtime-key",
				headers: { "x-runtime": "yes" },
				env: { A: "B" },
			})),
		};

		const result = await createCompletionHandler(complete)(context(registry))({ prompt: "hello" });

		expect(registry.getApiKeyAndHeaders).toHaveBeenCalledWith(model);
		expect(complete).toHaveBeenCalledWith(
			model,
			expect.objectContaining({ messages: [expect.objectContaining({ role: "user" })] }),
			expect.objectContaining({ apiKey: "runtime-key", headers: { "x-runtime": "yes" }, env: { A: "B" } }),
		);
		expect(result).toEqual({ text: "done", details: { model: "fake/fake-model", structured: false } });
	});

	it("parses schema completion JSON into a structured value", async () => {
		const complete = vi.fn(async () => textMessage('{"answer":42}'));
		const registry = { getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "runtime-key" })) };

		const result = await createCompletionHandler(complete)(context(registry))({
			prompt: "json",
			schema: { type: "object", properties: { answer: { type: "number" } } },
		});

		expect(result).toEqual({ value: { answer: 42 }, details: { model: "fake/fake-model", structured: true } });
	});

	it("throws a typed no model/credentials error when no current model is available", async () => {
		const registry = { getApiKeyAndHeaders: vi.fn() };

		await expect(createCompletionHandler()(context(registry, null))({ prompt: "hello" })).rejects.toThrow(
			"completion() has no model/credentials",
		);
		expect(registry.getApiKeyAndHeaders).not.toHaveBeenCalled();
	});

	it("throws a typed no model/credentials error when registry has no credentials", async () => {
		const registry = { getApiKeyAndHeaders: vi.fn(async () => ({ ok: true })) };

		await expect(createCompletionHandler()(context(registry))({ prompt: "hello" })).rejects.toThrow(
			"completion() has no model/credentials",
		);
	});

	it("rejects unsupported role aliases instead of inventing smol/slow roles", async () => {
		const registry = { getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "runtime-key" })) };

		await expect(createCompletionHandler()(context(registry))({ prompt: "hello", model: "smol" })).rejects.toThrow(
			"completion() model roles are not supported",
		);
	});

	it("aborts a mid-run cell during session_shutdown without unhandled rejection", async () => {
		const pi = new FakePi();
		const manager = new DisposableManager(1);
		senpiCodemode(pi as unknown as ExtensionAPI, { createSessionManager: () => manager });
		const ctx = context({ getApiKeyAndHeaders: vi.fn() });
		await emit(pi, "session_start", { reason: "startup" }, ctx);
		const tool = pi.registeredTool;
		expect(tool).toBeDefined();
		const run = tool?.execute("cell-running", { language: "js", code: "await pending()" }, undefined, undefined, ctx);
		await waitFor(() => manager.pendingRunResolvers.length === 1);
		await emit(pi, "session_shutdown", {}, ctx);

		await expect(run).resolves.toMatchObject({ details: expect.objectContaining({ isError: false }) });
		expect(manager.disposeCount).toBe(1);
		expect(manager.runControllers[0]?.signal.aborted).toBe(true);
	});
});

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt++) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("condition was not met");
}
