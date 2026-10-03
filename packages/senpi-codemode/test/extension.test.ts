import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, ExtensionToolContext } from "@code-yeongyu/senpi";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { CodemodeSessionManager } from "../src/extension/session-manager.ts";
import senpiCodemode, { type CodemodeExtensionAPI } from "../src/index.ts";
import type { EvalKernelResult, EvalKernelRunInput, KernelInterruptHandle } from "../src/tool/types.ts";
import { fakeExtensionContext, result } from "./eval/fakes.ts";
import { QueuedFakeKernel } from "./eval/queued-fake.ts";

interface RegisteredHandler {
	readonly event: string;
	readonly handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void;
}

class FakePi {
	readonly tools: string[] = [];
	readonly handlers: RegisteredHandler[] = [];
	readonly messages: string[] = [];
	readonly deliveries: Array<{ readonly content: string; readonly deliverAs: "steer" | "followUp" | undefined }> = [];
	readonly removedToolHints: Record<string, string> = {};
	readonly #nextMessage = Promise.withResolvers<string>();
	readonly activeTools = new Set<string>(["eval"]);
	registeredTool: Parameters<CodemodeExtensionAPI["registerTool"]>[0] | undefined;
	registerTool(tool: Parameters<CodemodeExtensionAPI["registerTool"]>[0]): void {
		this.tools.push(tool.name);
		this.activeTools.add(tool.name);
		if (tool.name === "eval") this.registeredTool = tool;
	}
	registerRemovedToolHint(name: string, hint: string): void {
		this.removedToolHints[name] = hint;
	}
	on(event: string, handler: RegisteredHandler["handler"]): void {
		this.handlers.push({ event, handler });
	}
	getActiveTools(): string[] {
		return [...this.activeTools];
	}
	getAllTools(): readonly { readonly name: string }[] {
		return this.tools.map((name) => ({ name }));
	}
	setActiveTools(toolNames: string[]): void {
		this.activeTools.clear();
		for (const toolName of toolNames) this.activeTools.add(toolName);
	}
	async executeTool(): Promise<never> {
		throw new Error("nested tool execution was not expected");
	}
	sendMessage(
		message: { customType: string; content: string; display: boolean },
		options?: { readonly deliverAs?: "steer" | "followUp" },
	): void {
		this.messages.push(message.content);
		this.deliveries.push({ content: message.content, deliverAs: options?.deliverAs });
		this.#nextMessage.resolve(message.content);
	}
	nextMessage(): Promise<string> {
		return this.#nextMessage.promise;
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
		cancelQueued(cellId: string, reason: string): boolean;
		interrupt(reason?: string, cellId?: string): Promise<KernelInterruptHandle>;
		queueSnapshot(): { activeCellId: string | null; queuedCellIds: readonly string[] };
		deliverToolReply(): void;
		reset(): Promise<void>;
		close(): Promise<void>;
	}> {
		if (this.#disposed) throw new Error("manager disposed");
		this.getKernelCount++;
		const controller = new AbortController();
		this.runControllers.push(controller);
		let activeCellId: string | null = null;
		return {
			run: async (input) => {
				activeCellId = input.cellId;
				input.onStarted?.();
				this.runStarted.resolve();
				return await new Promise((resolve) => {
					controller.signal.addEventListener(
						"abort",
						() => {
							activeCellId = null;
							resolve({
								type: "result",
								cellId: input.cellId,
								ok: false,
								error: { message: "kernel disposed" },
								durationMs: 0,
							});
						},
						{ once: true },
					);
				});
			},
			cancelQueued: () => false,
			queueSnapshot: () => ({ activeCellId, queuedCellIds: [] }),
			interrupt: async (reason) => {
				this.events.push("interrupt");
				controller.abort(reason);
				return { stateRetained: Promise.resolve(true) };
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

function extensionContext(cwd = process.cwd()): ExtensionToolContext {
	const base = fakeExtensionContext();
	return {
		...base,
		cwd,
		sessionManager: {
			...base.sessionManager,
			getSessionId: () => "extension-test-session",
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
	afterEach(() => {
		vi.clearAllMocks();
		vi.unstubAllEnvs();
		vi.useRealTimers();
	});

	it("keeps the environment cap after session start and model reselection", async () => {
		// Given a file cap distinct from both the default and environment override.
		const cwd = await mkdtemp(join(tmpdir(), "senpi-codemode-extension-cap-"));
		await mkdir(join(cwd, ".senpi"));
		await writeFile(
			join(cwd, ".senpi", "codemode.json"),
			JSON.stringify({
				languages: { js: true, py: false, rb: false, jl: false },
				cellTimeoutSeconds: 1,
				maxDetachedCells: 3,
			}),
		);
		vi.stubEnv("SENPI_CODEMODE_MAX_DETACHED_CELLS", "1");
		const pi = new FakePi();
		const kernel = new QueuedFakeKernel();
		const ctx = { ...extensionContext(cwd), mode: "tui" as const };
		const pending: Promise<unknown>[] = [];
		senpiCodemode(pi, {
			createSessionManager: () => ({
				getKernel: async () => kernel,
				dispose: async () => {},
				complete: async () => ({ text: "", details: { model: "unused", structured: false } }),
			}),
		});
		try {
			// When a real extension registration is replaced on session start and model select.
			await emit(pi, "session_start", { reason: "startup" }, ctx);
			await emit(pi, "model_select", { model: fakeModel("gpt-5.6") }, ctx);
			vi.useFakeTimers();
			const tool = pi.registeredTool;
			if (!tool) throw new Error("eval tool was not registered");
			for (const id of ["cap-A", "cap-B"]) {
				const admitted = kernel.admitted(id);
				pending.push(tool.execute(id, { language: "js", code: id, summary: id }, undefined, undefined, ctx));
				await admitted;
				await vi.advanceTimersByTimeAsync(1000);
			}
			// Then B remains foreground at capacity instead of occupying a second background slot.
			const listed = await tool.execute("list-cap", { action: "list" }, undefined, undefined, ctx);
			expect(listed.details.cells).toMatchObject([
				{ cellId: "cap-A", state: "detached" },
				{ cellId: "cap-B", state: "queued" },
			]);
		} finally {
			while (kernel.queueSnapshot().activeCellId !== null) {
				const active = kernel.queueSnapshot().activeCellId;
				if (active !== null) kernel.completeDeferredRun(result(active, "finished"));
			}
			await Promise.all(pending);
			await emit(pi, "session_shutdown", {}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

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
				tool.execute(
					"disabled-ruby",
					{ language: "rb", code: "1", summary: "disabled probe" },
					undefined,
					undefined,
					ctx,
				),
			).rejects.toThrow('Unsupported eval language "rb". Enabled languages: js');
		} finally {
			await emit(pi, "session_shutdown", {}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("exposes agent()/output()/<workflow> in the registered description when the task tool is active", async () => {
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
			expect(tool.description).toContain("<workflow>");
		} finally {
			await emit(pi, "session_shutdown", {}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("omits agent()/output()/<workflow> from the registered description when no task tool is active", async () => {
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
			expect(tool.description).not.toContain("<workflow>");
		} finally {
			await emit(pi, "session_shutdown", {}, ctx);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("registers only eval with the GPT dialect for GPT models", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "senpi-codemode-gpt-eval-"));
		const pi = new FakePi();
		const manager = new DisposableManager();
		senpiCodemode(pi, { createSessionManager: () => manager });
		const ctx = { ...extensionContext(cwd), model: fakeModel("gpt-5.6") };

		try {
			await emit(pi, "session_start", { reason: "startup" }, ctx);

			const tool = pi.registeredTool;
			if (!tool) throw new Error("eval tool was not registered");
			expect([...new Set(pi.tools)]).toEqual(["eval"]);
			expect(pi.activeTools).toEqual(new Set(["eval"]));
			expect(pi.removedToolHints).toEqual({
				exec: expect.stringContaining("use eval"),
				wait: expect.stringContaining("eval"),
			});
			expect(tool.description).toContain("<gpt_eval_dialect>");
			expect(tool.description).toContain("detach on their own");
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

			// Then eval is re-registered with the GPT dialect
			const switched = pi.registeredTool;
			if (!switched) throw new Error("eval tool was not re-registered");
			expect(switched.description).toContain("<gpt_eval_dialect>");
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
		await emit(pi, "session_shutdown", { reason: "resume" }, ctx);
		await emit(pi, "session_start", { reason: "switch" }, ctx);
		await emit(pi, "session_shutdown", { reason: "fork" }, ctx);
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
			tool.execute(
				"after-shutdown",
				{ language: "js", code: "1", summary: "post shutdown" },
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow("session has not started");
		expect(manager.getKernelCount).toBe(0);
	});
});

describe("senpi-codemode extension lifecycle", () => {
	afterEach(() => vi.useRealTimers());

	it("Given a session_start whose runtime could not be created, when the next eval runs, then the runtime is re-created once, the cell runs, and one diagnostic names the failed start", async () => {
		const pi = new FakePi();
		const manager = new DisposableManager();
		let attempts = 0;
		senpiCodemode(pi, {
			createSessionManager: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error("bridge port unavailable");
				return manager;
			},
		});
		const ctx = extensionContext();
		const written: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
			written.push(String(chunk));
			return true;
		});
		await emit(pi, "session_start", { reason: "startup" }, ctx).catch(() => undefined);

		const run = pi.registeredTool?.execute(
			"after-failed-start",
			{ language: "js", code: "1", summary: "cell after a failed start" },
			undefined,
			undefined,
			ctx,
		);
		const outcome = await Promise.race([
			manager.runStarted.promise.then(() => "kernel reached"),
			Promise.resolve(run).then(
				(settled) => JSON.stringify(settled?.content ?? settled),
				(error: unknown) => String(error),
			),
		]);

		expect(outcome).toBe("kernel reached");

		expect(attempts).toBe(2);
		const diagnostics = written.filter((line) => line.includes("re-created a runtime"));
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatch(/failed session_start \(session [0-9a-f]{12}\)/);
		expect(diagnostics[0]).not.toContain("bridge port unavailable");
		await emit(pi, "session_shutdown", {}, ctx);
		await run;
	});

	it("Given a failed start whose re-creation also fails, when eval runs, then the error names the re-creation failure and the remedy, and later evals report it without retrying", async () => {
		const pi = new FakePi();
		let attempts = 0;
		senpiCodemode(pi, {
			createSessionManager: async () => {
				attempts += 1;
				throw new Error("bridge port unavailable");
			},
		});
		const ctx = extensionContext();
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		await emit(pi, "session_start", { reason: "startup" }, ctx).catch(() => undefined);

		const run = pi.registeredTool?.execute(
			"re-creation-fails",
			{ language: "js", code: "1", summary: "cell after a failed start" },
			undefined,
			undefined,
			ctx,
		);

		await expect(run).rejects.toThrow(
			"codemode runtime could not be re-created: bridge port unavailable. Start a new session or reload to bring eval back.",
		);
		const again = pi.registeredTool?.execute(
			"re-creation-fails-again",
			{ language: "js", code: "1", summary: "second cell after a failed start" },
			undefined,
			undefined,
			ctx,
		);
		await expect(again).rejects.toThrow("codemode runtime could not be re-created: bridge port unavailable");
		expect(attempts).toBe(2);
	});

	it.each([
		{ path: "a fresh session_start", shutdown: undefined, start: "startup" },
		{ path: "a session switch", shutdown: "resume", start: "resume" },
		{ path: "a fork", shutdown: "fork", start: "fork" },
		{ path: "a reload", shutdown: "reload", start: "reload" },
		{ path: "a new session", shutdown: "new", start: "new" },
	] as const)(
		"Given a failed re-creation that later evals keep reporting, when $path starts the session again, then eval works without a restart",
		async ({ shutdown, start }) => {
			const pi = new FakePi();
			const manager = new DisposableManager();
			let attempts = 0;
			senpiCodemode(pi, {
				createSessionManager: async () => {
					attempts += 1;
					if (attempts <= 2) throw new Error("bridge port unavailable");
					return manager;
				},
			});
			const ctx = extensionContext();
			vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			const evalOnce = (id: string) =>
				pi.registeredTool?.execute(id, { language: "js", code: "1", summary: id }, undefined, undefined, ctx);
			await emit(pi, "session_start", { reason: "startup" }, ctx).catch(() => undefined);
			await expect(evalOnce("recreation-fails")).rejects.toThrow("codemode runtime could not be re-created");

			if (shutdown !== undefined) await emit(pi, "session_shutdown", { reason: shutdown }, ctx);
			await emit(pi, "session_start", { reason: start }, ctx);
			const run = evalOnce("after-fresh-start");
			const outcome = await Promise.race([
				manager.runStarted.promise.then(() => "kernel reached"),
				Promise.resolve(run).then(
					(settled) => JSON.stringify(settled?.content ?? settled),
					(error: unknown) => String(error),
				),
			]);

			expect(outcome).toBe("kernel reached");
			expect(attempts).toBe(3);
			await emit(pi, "session_shutdown", {}, ctx);
			await Promise.allSettled([run]);
		},
	);

	it("Given a failed start, when two evals arrive together, then they share one re-creation and one diagnostic", async () => {
		const pi = new FakePi();
		const managers: DisposableManager[] = [];
		let attempts = 0;
		senpiCodemode(pi, {
			createSessionManager: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error("bridge port unavailable");
				const manager = new DisposableManager();
				managers.push(manager);
				return manager;
			},
		});
		const ctx = extensionContext();
		const written: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
			written.push(String(chunk));
			return true;
		});
		await emit(pi, "session_start", { reason: "startup" }, ctx).catch(() => undefined);

		const cells = ["first", "second"].map((name) =>
			pi.registeredTool?.execute(
				`together-${name}`,
				{ language: "js", code: "1", summary: `cell ${name}` },
				undefined,
				undefined,
				ctx,
			),
		);
		await managers[0]?.runStarted.promise;
		await vi.waitFor(() => expect(managers[0]?.getKernelCount).toBe(2));

		expect(attempts).toBe(2);
		expect(managers).toHaveLength(1);
		expect(written.filter((line) => line.includes("re-created a runtime"))).toHaveLength(1);
		await emit(pi, "session_shutdown", {}, ctx);
		await Promise.allSettled(cells);
	});

	it("Given a session that ended with session_shutdown, when eval runs afterwards, then it is not recovered and no diagnostic is written", async () => {
		const pi = new FakePi();
		let created = 0;
		senpiCodemode(pi, {
			createSessionManager: () => {
				created += 1;
				return new DisposableManager();
			},
		});
		const ctx = extensionContext();
		const written: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
			written.push(String(chunk));
			return true;
		});
		await emit(pi, "session_start", { reason: "startup" }, ctx);
		await emit(pi, "session_shutdown", { reason: "quit" }, ctx);

		const run = pi.registeredTool?.execute(
			"after-shutdown",
			{ language: "js", code: "1", summary: "cell after shutdown" },
			undefined,
			undefined,
			ctx,
		);

		await expect(run).rejects.toThrow("codemode session manager is disposed");
		expect(created).toBe(1);
		expect(written.some((line) => line.includes("re-created a runtime"))).toBe(false);
	});

	it.each(["session_before_switch", "session_before_fork"] as const)(
		"Given a %s that another extension cancels (or that fails before teardown), when the session keeps running, then eval still reaches its kernel",
		async (beforeEvent) => {
			const pi = new FakePi();
			const manager = new DisposableManager();
			senpiCodemode(pi, { createSessionManager: () => manager });
			const ctx = extensionContext();
			const written: string[] = [];
			vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
				written.push(String(chunk));
				return true;
			});
			await emit(pi, "session_start", { reason: "startup" }, ctx);

			// The switch or fork never happens: no session_shutdown and no new session_start follow.
			await emit(pi, beforeEvent, {}, ctx);
			const run = pi.registeredTool?.execute(
				"after-cancelled-replacement",
				{ language: "js", code: "1", summary: "cell after a cancelled switch" },
				undefined,
				undefined,
				ctx,
			);
			const outcome = await Promise.race([
				manager.runStarted.promise.then(() => "kernel reached"),
				Promise.resolve(run).then((settled) => JSON.stringify(settled?.content ?? settled)),
			]);

			expect(outcome).toBe("kernel reached");
			expect(manager.disposeCount).toBe(0);
			// The primary fix keeps the manager, so the recovery path never runs here.
			expect(written.some((line) => line.includes("re-created a runtime"))).toBe(false);
			await emit(pi, "session_shutdown", {}, ctx);
			await run;
		},
	);

	it("settles a mid-run cell as an error and rejects post-shutdown work", async () => {
		const pi = new FakePi();
		const manager = new DisposableManager();
		senpiCodemode(pi, { createSessionManager: () => manager });
		const ctx = extensionContext();
		await emit(pi, "session_start", { reason: "startup" }, ctx);
		const tool = pi.registeredTool;
		expect(tool).toBeDefined();
		const run = tool?.execute(
			"cell-running",
			{ language: "js", code: "await pending()", summary: "mid run cell" },
			undefined,
			undefined,
			ctx,
		);
		await manager.runStarted.promise;
		await emit(pi, "session_shutdown", {}, ctx);

		await expect(run).resolves.toMatchObject({ details: expect.objectContaining({ isError: true }) });
		await expect(
			tool?.execute(
				"after-shutdown",
				{ language: "js", code: "1", summary: "post shutdown" },
				undefined,
				undefined,
				ctx,
			),
		).rejects.toMatchObject({ name: "CodemodeSessionDisposedError" });
		expect([manager.disposeCount, manager.getKernelCount]).toEqual([1, 1]);
		expect(manager.runControllers[0]?.signal.aborted).toBe(true);
	});

	it("injects one guarded interactive completion notification for a detached cell", async () => {
		vi.useFakeTimers();
		const pi = new FakePi();
		const manager = new DisposableManager();
		senpiCodemode(pi, { createSessionManager: () => manager });
		const ctx = { ...extensionContext(), mode: "tui" as const, model: fakeModel("claude-opus-4-8") };
		await emit(pi, "session_start", { reason: "startup" }, ctx);
		const tool = pi.registeredTool;
		if (!tool) throw new Error("eval tool was not registered");
		const notification = pi.nextMessage();
		const run = tool.execute(
			"notified-detached",
			{ language: "js", code: "await pending()", on_timeout: "detach", summary: "notified detached" },
			undefined,
			undefined,
			ctx,
		);
		await manager.runStarted.promise;
		await vi.advanceTimersByTimeAsync(30_000);
		await run;

		manager.runControllers[0]?.abort(new Error("kernel crashed"));
		const content = await notification;

		expect(pi.deliveries).toEqual([{ content, deliverAs: "steer" }]);
		expect(content).toContain("notified-detached");
		expect(content).toContain("kernel disposed");
		expect(content).toContain("Kernel state updated - variables are available to the next eval cell.");
		await emit(pi, "session_shutdown", {}, ctx);
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
		const run = tool.execute(
			"tracked-cell",
			{ language: "js", code: "await pending()", summary: "tracked cell" },
			undefined,
			undefined,
			ctx,
		);
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
			tool.execute(
				"after-shutdown",
				{ language: "js", code: "1", summary: "post shutdown" },
				undefined,
				undefined,
				ctx,
			),
		).rejects.toMatchObject({ name: "CodemodeSessionDisposedError" });
	});
});
