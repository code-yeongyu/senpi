import type { ExtensionContext } from "@code-yeongyu/senpi";
import type { KernelToHostMessage } from "./bridge/protocol.ts";
import type { AgentExecuteTool } from "./bridges/agent-bridge.ts";
import { type CompletionRequest, type CompletionResult, createCompletionHandler } from "./completion/handler.ts";
import {
	type CodemodeSettings,
	defaultCodemodeSettings,
	loadCodemodeSettings,
	type ResolvedCodemodeSettings,
	resolveEnabledLanguages,
} from "./config/settings.ts";
import {
	CodemodeSessionDisposedError,
	type CodemodeSessionManager,
	type CreateCodemodeSessionManagerOptions,
	createCodemodeSessionManager,
	type EvalExecutionTracker,
} from "./extension/session-manager.ts";
import {
	createInterpreterDetector,
	getInterpreterAvailability,
	type InterpreterAvailability,
} from "./interpreters/detect.ts";
import { resolveSessionArtifactsDir } from "./output/streaming-output.ts";
import { createEvalTool } from "./tool/eval-tool.ts";
import { renderEvalCall, renderEvalResult } from "./tool/render.ts";
import type { EnabledEvalLanguages, EvalKernel, EvalLanguage } from "./tool/types.ts";

const SESSION_LIFECYCLE_EVENTS = [
	"session_start",
	"session_shutdown",
	"session_before_switch",
	"session_before_fork",
] as const;

type SessionLifecycleEvent = (typeof SESSION_LIFECYCLE_EVENTS)[number];

type CodemodeEvent = SessionLifecycleEvent | "model_select";

type TrackedExecution = {
	readonly promise: Promise<unknown>;
	readonly controller: AbortController;
};

type SessionRuntime = {
	readonly manager: CodemodeSessionManager;
	readonly enabledLanguages: EnabledEvalLanguages;
	readonly settings: ResolvedCodemodeSettings;
	readonly artifactsDir: string;
	readonly executeTool: AgentExecuteTool;
	readonly spawns: boolean;
};

export interface CodemodeExtensionAPI {
	registerTool(tool: ReturnType<typeof createEvalTool>): void;
	on(event: CodemodeEvent, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void): void;
	executeTool: AgentExecuteTool;
	getActiveTools(): string[];
}

export interface SenpiCodemodeOptions {
	readonly createSessionManager?: (
		options: CreateCodemodeSessionManagerOptions,
	) => CodemodeSessionManager | Promise<CodemodeSessionManager>;
	readonly complete?: (request: CompletionRequest, ctx: ExtensionContext) => Promise<CompletionResult>;
}

class CodemodeSessionNotStartedError extends Error {
	readonly name = "CodemodeSessionNotStartedError";

	constructor() {
		super("codemode session has not started");
	}
}

export default function senpiCodemode(pi: CodemodeExtensionAPI, options: SenpiCodemodeOptions = {}): void {
	const manager = new SessionManagerProxy();
	const complete = options.complete ?? ((request, ctx) => createCompletionHandler()(ctx)(request));
	const renderers = { renderCall: renderEvalCall, renderResult: renderEvalResult };
	let activeRuntime: SessionRuntime | undefined;
	let activeModelId: string | undefined;
	const registerEvalForRuntime = (runtime: SessionRuntime, modelId: string | undefined): void => {
		pi.registerTool(
			createEvalTool({
				enabledLanguages: runtime.enabledLanguages,
				kernelManager: manager,
				cellTimeoutSeconds: runtime.settings.cellTimeoutSeconds,
				executeTool: runtime.executeTool,
				complete,
				settings: runtime.settings,
				artifactsDir: runtime.artifactsDir,
				executionTracker: manager,
				renderers,
				spawns: runtime.spawns,
				spawnDefaultAgent: runtime.settings.taskTools.task,
				...(modelId === undefined ? {} : { modelId }),
			}),
		);
	};
	const dropRuntime = async (): Promise<void> => {
		activeRuntime = undefined;
		activeModelId = undefined;
		await manager.dispose();
	};
	pi.registerTool(
		createEvalTool({
			enabledLanguages: { py: true, js: true, rb: true, jl: true },
			kernelManager: manager,
			cellTimeoutSeconds: defaultCodemodeSettings.cellTimeoutSeconds,
			executeTool: createExecuteTool(pi),
			complete,
			settings: defaultCodemodeSettings,
			executionTracker: manager,
			renderers,
		}),
	);

	pi.on("session_start", async (event, ctx) => {
		const generation = manager.beginReplacement();
		const runtime = await createRuntime(pi, ctx, event, complete, options);
		if (!(await manager.replace(generation, runtime.manager))) return;
		activeRuntime = runtime;
		activeModelId = ctx.model?.id;
		registerEvalForRuntime(runtime, activeModelId);
	});
	pi.on("session_shutdown", async () => dropRuntime());
	pi.on("session_before_switch", async () => dropRuntime());
	pi.on("session_before_fork", async () => dropRuntime());
	pi.on("model_select", async (event) => {
		const runtime = activeRuntime;
		if (runtime === undefined) return;
		const modelId = modelIdFrom(event);
		if (modelId === undefined || modelId === activeModelId) return;
		activeModelId = modelId;
		registerEvalForRuntime(runtime, modelId);
	});
}

function modelIdFrom(event: unknown): string | undefined {
	if (typeof event !== "object" || event === null || !("model" in event)) return undefined;
	const model = event.model;
	if (typeof model !== "object" || model === null || !("id" in model)) return undefined;
	return typeof model.id === "string" ? model.id : undefined;
}

class SessionManagerProxy implements CodemodeSessionManager, EvalExecutionTracker {
	#current: CodemodeSessionManager | undefined;
	#generation = 0;
	#started = false;
	#acceptingExecutions = false;
	readonly #executions = new Set<TrackedExecution>();

	beginReplacement(): number {
		this.#generation++;
		this.#acceptingExecutions = false;
		this.#abortExecutions();
		return this.#generation;
	}

	async replace(generation: number, next: CodemodeSessionManager): Promise<boolean> {
		if (generation !== this.#generation) {
			await next.dispose();
			return false;
		}
		await this.#settleExecutions();
		if (generation !== this.#generation) {
			await next.dispose();
			return false;
		}
		const current = this.#current;
		this.#current = undefined;
		await current?.dispose();
		if (generation !== this.#generation) {
			await next.dispose();
			return false;
		}
		this.#current = next;
		this.#started = true;
		this.#acceptingExecutions = true;
		return true;
	}

	assertEvalExecutionAllowed(): void {
		if (this.#acceptingExecutions && this.#current !== undefined) return;
		if (this.#started) throw new CodemodeSessionDisposedError();
		throw new CodemodeSessionNotStartedError();
	}

	async trackEvalExecution<Result>(execution: Promise<Result>, controller: AbortController): Promise<Result> {
		this.assertEvalExecutionAllowed();
		const tracked: TrackedExecution = { promise: execution, controller };
		this.#executions.add(tracked);
		try {
			return await execution;
		} finally {
			this.#executions.delete(tracked);
		}
	}

	async getKernel(language: EvalLanguage, onMessage: (message: KernelToHostMessage) => void): Promise<EvalKernel> {
		this.assertEvalExecutionAllowed();
		const current = this.#current;
		if (current === undefined) throw new CodemodeSessionNotStartedError();
		return await current.getKernel(language, onMessage);
	}

	async complete(request: CompletionRequest, ctx: ExtensionContext): Promise<CompletionResult> {
		this.assertEvalExecutionAllowed();
		const current = this.#current;
		if (current === undefined) throw new CodemodeSessionNotStartedError();
		return await current.complete(request, ctx);
	}

	setContext(ctx: ExtensionContext): void {
		this.#current?.setContext?.(ctx);
	}

	async dispose(): Promise<void> {
		this.#generation++;
		this.#acceptingExecutions = false;
		this.#abortExecutions();
		await this.#settleExecutions();
		const current = this.#current;
		this.#current = undefined;
		await current?.dispose();
	}

	#abortExecutions(): void {
		if (this.#executions.size === 0) return;
		const error = new CodemodeSessionDisposedError();
		for (const execution of this.#executions) execution.controller.abort(error);
	}

	async #settleExecutions(): Promise<void> {
		if (this.#executions.size === 0) return;
		await Promise.allSettled([...this.#executions].map((execution) => execution.promise));
	}
}

async function createRuntime(
	pi: CodemodeExtensionAPI,
	ctx: ExtensionContext,
	event: unknown,
	complete: (request: CompletionRequest, ctx: ExtensionContext) => Promise<CompletionResult>,
	options: SenpiCodemodeOptions,
): Promise<SessionRuntime> {
	const loaded = await loadCodemodeSettings({ cwd: ctx.cwd });
	const settings: ResolvedCodemodeSettings = {
		...loaded.settings,
		languages: resolveEnabledLanguages(loaded.settings),
	};
	const availability = await getInterpreterAvailability(settings, createInterpreterDetector());
	const enabledLanguages = enabledLanguagesFrom(settings, availability);
	const artifacts = resolveSessionArtifactsDir(ctx.sessionManager.getSessionFile());
	const activeTools = new Set(pi.getActiveTools());
	const executeTool = createExecuteTool(pi, activeTools);
	const create = options.createSessionManager ?? createCodemodeSessionManager;
	const manager = await create({
		sessionId: sessionIdFrom(event),
		cwd: ctx.cwd,
		settings,
		availability,
		artifactsDir: artifacts.dir,
		executeTool,
		complete,
	});
	return {
		manager,
		enabledLanguages,
		settings,
		artifactsDir: artifacts.dir,
		executeTool,
		spawns: activeTools.has(settings.taskTools.task),
	};
}

function createExecuteTool(pi: CodemodeExtensionAPI, activeTools?: ReadonlySet<string>): AgentExecuteTool {
	const executeTool: AgentExecuteTool = (toolName, params, executeOptions) =>
		pi.executeTool(toolName, params, executeOptions);
	return Object.assign(executeTool, {
		isToolAvailable: (name: string): boolean => activeTools?.has(name) ?? pi.getActiveTools().includes(name),
	});
}

function sessionIdFrom(event: unknown): string {
	if (typeof event === "object" && event !== null && "sessionId" in event && typeof event.sessionId === "string") {
		return event.sessionId;
	}
	return crypto.randomUUID();
}

export function enabledLanguagesFrom(
	settings: CodemodeSettings,
	availability: InterpreterAvailability,
): Record<EvalLanguage, boolean> {
	return {
		py: settings.languages.py && availability.py.detected.ok,
		js: settings.languages.js && availability.js.detected.ok,
		rb: settings.languages.rb && availability.rb.detected.ok,
		jl: settings.languages.jl && availability.jl.detected.ok,
	};
}
