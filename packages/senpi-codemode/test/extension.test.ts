import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@code-yeongyu/senpi";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
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
	readonly activeTools = new Set<string>(["eval"]);
	registeredTool: Parameters<CodemodeExtensionAPI["registerTool"]>[0] | undefined;
	registerTool(tool: Parameters<CodemodeExtensionAPI["registerTool"]>[0]): void {
		this.tools.push(tool.name);
		this.activeTools.add(tool.name);
		if (tool.name === "eval") this.registeredTool = tool;
	}
	on(event: string, handler: RegisteredHandler["handler"]): void {
		this.handlers.push({ event, handler });
	}
	getActiveTools(): string[] {
		return [...this.activeTools];
	}
	async executeTool(): Promise<never> {
		throw new Error("nested tool execution was not expected");
	}
}

class DisposableManager implements CodemodeSessionManager {
	readonly runControllers: AbortController[] = [];
	readonly runStarted = Promise.withResolvers<void>();
	readonly events: string[] = [];
	readonly #abortOnDispose: boolean;
	#disposed = false;
	disposeCount = 0;
	getKernelCount = 0;

	constructor(abortOnDispose = true) {
		this.#abortOnDispose = abortOnDispose;
	}

	async getKernel(): Promise<{
		run(input: EvalKernelRunInput): Promise<EvalKernelResult>;
		interrupt(reason?: string): Promise<void>;
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
			interrupt: async (reason) => {
				this.events.push("interrupt");
				controller.abort(reason);
			},
			deliverToolReply: () => undefined,
			reset: async () => undefined,
			close: async () => undefined,
		};
	}

	async dispose(): Promise<void> {
		this.#disposed = true;
		this.disposeCount++;
		this.events.push("dispose");
		if (this.#abortOnDispose) {
			for (const controller of this.runControllers) controller.abort();
		}
	}

	async complete(): Promise<{
		readonly text: string;
		readonly details: { readonly model: string; readonly structured: false };
	}> {
		return { text: "ok", details: { model: "fake/fake-model", structured: false } };
	}
}

const extensionArtifactsRoot = join(tmpdir(), `senpi-codemode-extension-tests-${process.pid}`);

afterAll(async () => {
	await rm(extensionArtifactsRoot, { recursive: true, force: true });
});

function extensionContext(cwd = process.cwd()): ExtensionContext {
	const base = fakeExtensionContext();
	return {
		...base,
		cwd,
		sessionManager: {
			...base.sessionManager,
			getSessionFile: () => join(extensionArtifactsRoot, `${crypto.randomUUID()}.jsonl`),
		},
	};
}

function fakeModel(id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "fake-api",
		provider: "fake",
		baseUrl: "https://fake.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
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

	it("re-registers eval after session start with only enabled and available languages", async () => {
		// Given
		const cwd = await mkdtemp(join(tmpdir(), "senpi-codemode-extension-"));
		await mkdir(join(cwd, ".senpi"), { recursive: true });
		await writeFile(
			join(cwd, ".senpi", "codemode.json"),
			JSON.stringify({ languages: { py: false, js: true, rb: false, jl: false } }),
		);
		const pi = new FakePi();
		const manager = new DisposableManager();
		senpiCodemode(pi, { createSessionManager: () => manager });
		const ctx = extensionContext(cwd);

		try {
			// When
			await emit(pi, "session_start", { reason: "startup" }, ctx);

			// Then
			expect(pi.tools).toEqual(["eval", "eval"]);
			const tool = pi.registeredTool;
			if (!tool) throw new Error("eval tool was not registered");
			expect(tool.parameters.properties.language.anyOf).toEqual([{ const: "js", type: "string" }]);
			expect(tool.description).toContain('`"js"`');
			expect(tool.description).not.toContain('`"py"`');
			expect(tool.description).not.toContain('`"rb"`');
			expect(tool.description).not.toContain('`"jl"`');
			await expect(
				tool.execute("disabled-ruby", { language: "rb", code: "1" }, undefined, undefined, ctx),
			).rejects.toThrow('Unsupported eval language "rb". Enabled languages: js');
		} finally {
			await emit(pi, "session_shutdown", {}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("exposes agent()/output()/<dag> in the registered description when the task tool is active", async () => {
		// Given a session where the `task` tool is registered alongside eval
		const cwd = await mkdtemp(join(tmpdir(), "senpi-codemode-spawns-"));
		await mkdir(join(cwd, ".senpi"), { recursive: true });
		await writeFile(
			join(cwd, ".senpi", "codemode.json"),
			JSON.stringify({ languages: { py: true, js: true, rb: false, jl: false } }),
		);
		const pi = new FakePi();
		pi.activeTools.add("task");
		const manager = new DisposableManager();
		senpiCodemode(pi, { createSessionManager: () => manager });
		const ctx = extensionContext(cwd);

		try {
			// When
			await emit(pi, "session_start", { reason: "startup" }, ctx);

			// Then the registered description advertises the spawn helpers
			const tool = pi.registeredTool;
			if (!tool) throw new Error("eval tool was not registered");
			expect(tool.description).toContain("agent(");
			expect(tool.description).toContain("output(");
			expect(tool.description).toContain("<dag>");
		} finally {
			await emit(pi, "session_shutdown", {}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("omits agent()/output()/<dag> from the registered description when no task tool is active", async () => {
		// Given a session with no `task` tool registered
		const cwd = await mkdtemp(join(tmpdir(), "senpi-codemode-nospawns-"));
		await mkdir(join(cwd, ".senpi"), { recursive: true });
		await writeFile(
			join(cwd, ".senpi", "codemode.json"),
			JSON.stringify({ languages: { py: true, js: true, rb: false, jl: false } }),
		);
		const pi = new FakePi();
		const manager = new DisposableManager();
		senpiCodemode(pi, { createSessionManager: () => manager });
		const ctx = extensionContext(cwd);

		try {
			// When
			await emit(pi, "session_start", { reason: "startup" }, ctx);

			// Then the registered description hides the spawn helpers
			const tool = pi.registeredTool;
			if (!tool) throw new Error("eval tool was not registered");
			expect(tool.description).not.toContain("agent(");
			expect(tool.description).not.toContain("<dag>");
		} finally {
			await emit(pi, "session_shutdown", {}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("registers the model-tuned dialect at session start and re-registers on model_select", async () => {
		// Given a session whose active model is a Claude family id
		const cwd = await mkdtemp(join(tmpdir(), "senpi-codemode-modelselect-"));
		await mkdir(join(cwd, ".senpi"), { recursive: true });
		await writeFile(
			join(cwd, ".senpi", "codemode.json"),
			JSON.stringify({ languages: { py: true, js: true, rb: false, jl: false } }),
		);
		const pi = new FakePi();
		const manager = new DisposableManager();
		senpiCodemode(pi, { createSessionManager: () => manager });
		const ctx = { ...extensionContext(cwd), model: fakeModel("claude-opus-4-8") };

		try {
			// When the session starts with the Claude model active
			await emit(pi, "session_start", { reason: "startup" }, ctx);

			// Then the registered description carries the Claude dialect
			const started = pi.registeredTool;
			if (!started) throw new Error("eval tool was not registered");
			expect(started.description).toContain("<eval_first_batching>");
			expect(started.description).not.toContain("EVAL IS YOUR PRIMARY EXECUTION SURFACE");

			// When the model switches to an OpenAI family id
			await emit(pi, "model_select", { model: fakeModel("gpt-5.6") }, ctx);

			// Then eval is re-registered with the codex dialect
			const switched = pi.registeredTool;
			if (!switched) throw new Error("eval tool was not re-registered");
			expect(switched.description).toContain("Route multi-call steps through eval");
			expect(switched.description).not.toContain("<eval_first_batching>");

			// And a same-model reselection does not re-register
			const registrations = pi.tools.length;
			await emit(pi, "model_select", { model: fakeModel("gpt-5.6") }, ctx);
			expect(pi.tools.length).toBe(registrations);
		} finally {
			await emit(pi, "session_shutdown", {}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("ignores model_select before any session has started", async () => {
		// Given an extension with no started session
		const pi = new FakePi();
		senpiCodemode(pi, { createSessionManager: () => new DisposableManager() });
		const ctx = extensionContext();

		// When a model_select arrives early
		await emit(pi, "model_select", { model: fakeModel("gpt-5.6") }, ctx);

		// Then only the load-time registration exists
		expect(pi.tools).toEqual(["eval"]);
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
		const ctx = extensionContext();

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
		const ctx = extensionContext();
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
		const ctx = extensionContext();
		await emit(pi, "session_start", { reason: "startup" }, ctx);
		const tool = pi.registeredTool;
		expect(tool).toBeDefined();
		const run = tool?.execute("cell-running", { language: "js", code: "await pending()" }, undefined, undefined, ctx);
		await manager.runStarted.promise;
		await emit(pi, "session_shutdown", {}, ctx);

		await expect(run).resolves.toMatchObject({ details: expect.objectContaining({ isError: true }) });
		await expect(
			tool?.execute("after-shutdown", { language: "js", code: "1" }, undefined, undefined, ctx),
		).rejects.toMatchObject({ name: "CodemodeSessionDisposedError" });
		expect([manager.disposeCount, manager.getKernelCount]).toEqual([1, 1]);
		expect(manager.runControllers[0]?.signal.aborted).toBe(true);
	});

	it("aborts and settles tracked eval work before disposing the session manager", async () => {
		// Given
		const pi = new FakePi();
		const manager = new DisposableManager(false);
		senpiCodemode(pi, { createSessionManager: () => manager });
		const ctx = extensionContext();
		await emit(pi, "session_start", { reason: "startup" }, ctx);
		const tool = pi.registeredTool;
		if (!tool) throw new Error("eval tool was not registered");
		const run = tool.execute("tracked-cell", { language: "js", code: "await pending()" }, undefined, undefined, ctx);
		await manager.runStarted.promise;

		// When
		await emit(pi, "session_shutdown", {}, ctx);
		const settled = await Promise.race([
			run,
			new Promise<never>((_resolve, reject) => {
				setTimeout(() => reject(new Error("tracked eval did not settle during shutdown")), 250);
			}),
		]);

		// Then
		expect(settled.details).toMatchObject({ isError: true, cells: [{ status: "error" }] });
		expect(manager.events).toEqual(["interrupt", "dispose"]);
		await expect(
			tool.execute("after-shutdown", { language: "js", code: "1" }, undefined, undefined, ctx),
		).rejects.toMatchObject({ name: "CodemodeSessionDisposedError" });
	});
});
