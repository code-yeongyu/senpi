import { join } from "node:path";
import type { ExtensionContext } from "@code-yeongyu/senpi";
import { type BridgeServerHandle, startBridgeServer } from "../bridge/http-server.ts";
import type { KernelToHostMessage } from "../bridge/protocol.ts";
import { isReservedToolName, runReservedTool } from "../bridges/reserved-dispatch.ts";
import type { EvalSchemaToolInfo } from "../bridges/schema-bridge.ts";
import type { CompletionRequest, CompletionResult } from "../completion/handler.ts";
import { type CodemodeSettings, defaultCodemodeSettings } from "../config/settings.ts";
import type { InterpreterAvailability } from "../interpreters/detect.ts";
import { JuliaKernel } from "../kernels/jl/kernel.ts";
import { JavaScriptKernel } from "../kernels/js/context-manager.ts";
import { PythonKernel } from "../kernels/py/kernel.ts";
import { RubyKernel } from "../kernels/rb/kernel.ts";
import { marshalToolResult } from "../tool/image.ts";
import type { EvalKernel, EvalKernelManager, EvalLanguage, ExecuteTool } from "../tool/types.ts";

export interface CodemodeSessionManager extends EvalKernelManager {
	dispose(): Promise<void>;
	complete(request: CompletionRequest, ctx: ExtensionContext): Promise<CompletionResult>;
	setContext?(ctx: ExtensionContext): void;
	bridgeEndpoint?(): BridgeEndpoint;
}

export interface BridgeEndpoint {
	readonly port: number;
	readonly token: string;
}

export interface EvalExecutionTracker {
	assertEvalExecutionAllowed(): void;
	trackEvalExecution<Result>(execution: Promise<Result>, controller: AbortController): Promise<Result>;
}

export interface CreateCodemodeSessionManagerOptions {
	readonly sessionId: string;
	readonly cwd: string;
	readonly settings: CodemodeSettings;
	readonly availability: InterpreterAvailability;
	/** Session-scoped roots exposed to kernel helpers such as local://. */
	readonly localRoots?: Readonly<Record<string, string>>;
	/** Session-adjacent directory used for persisted eval artifacts. */
	readonly artifactsDir?: string;
	readonly executeTool: ExecuteTool;
	readonly listTools?: () => readonly EvalSchemaToolInfo[];
	readonly complete: (request: CompletionRequest, ctx: ExtensionContext) => Promise<CompletionResult>;
}

export async function createCodemodeSessionManager(
	options: CreateCodemodeSessionManagerOptions,
): Promise<CodemodeSessionManager> {
	const manager = new DefaultCodemodeSessionManager(options);
	await manager.start();
	return manager;
}

export class CodemodeSessionDisposedError extends Error {
	readonly name = "CodemodeSessionDisposedError";

	constructor() {
		super("codemode session manager is disposed");
	}
}

class CodemodeContextUnavailableError extends Error {
	readonly name = "CodemodeContextUnavailableError";

	constructor() {
		super("codemode completion context is unavailable");
	}
}

class DefaultCodemodeSessionManager implements CodemodeSessionManager {
	readonly #options: CreateCodemodeSessionManagerOptions;
	#bridge: BridgeServerHandle | undefined;
	#kernels = new Map<EvalLanguage, EvalKernel>();
	#kernelCreations = new Map<EvalLanguage, Promise<EvalKernel>>();
	#onMessageRefs = new Map<EvalLanguage, (message: KernelToHostMessage) => void>();
	#context: ExtensionContext | undefined;
	#generation = 0;
	#disposePromise: Promise<void> | undefined;

	constructor(options: CreateCodemodeSessionManagerOptions) {
		this.#options = options;
	}

	async start(): Promise<void> {
		this.#bridge = await startBridgeServer({
			onCall: async (request) => await this.#call(request),
			onEmit: async () => undefined,
			onCompletion: async (request) =>
				this.#options.complete({ prompt: request.prompt, opts: request.opts }, this.#contextFor(request.signal)),
		});
	}

	// Subprocess kernels (py/rb/jl) reach the host only through this route, so reserved
	// helper names must dispatch exactly as the in-process JS path does in tool/cell-handler.ts.
	// Forwarding them to executeTool made agent() fail with "Unknown tool __agent__".
	async #call(request: { toolName: string; args: unknown; callId: string; signal: AbortSignal }): Promise<unknown> {
		if (!isReservedToolName(request.toolName)) {
			return await this.#options.executeTool(request.toolName, request.args, { signal: request.signal });
		}
		const taskTools = this.#options.settings.taskTools ?? defaultCodemodeSettings.taskTools;
		return await runReservedTool(request.toolName, {
			callId: request.callId,
			args: request.args,
			executeTool: this.#options.executeTool,
			taskToolName: taskTools.task,
			taskOutputToolName: taskTools.output,
			listTools: this.#options.listTools,
			signal: request.signal,
			emitStatus: () => {},
			marshalToolResult,
		});
	}

	async getKernel(language: EvalLanguage, onMessage: (message: KernelToHostMessage) => void): Promise<EvalKernel> {
		if (this.#disposePromise) throw new CodemodeSessionDisposedError();
		// Persistent kernels are reused across cells, but each cell needs its OWN
		// onMessage (bound to that cell's streaming state). Rebind on every call via
		// a stable dispatcher so the 2nd+ cell's text/display/log output is attributed
		// to the current cell, not the one that first created the kernel.
		this.#onMessageRefs.set(language, onMessage);
		const existing = this.#kernels.get(language);
		if (existing) return existing;
		const pending = this.#kernelCreations.get(language);
		if (pending) return await pending;
		const dispatch = (message: KernelToHostMessage): void => this.#onMessageRefs.get(language)?.(message);
		const generation = this.#generation;
		const creation = this.#createAndStoreKernel(language, dispatch, generation);
		this.#kernelCreations.set(language, creation);
		try {
			return await creation;
		} finally {
			if (this.#kernelCreations.get(language) === creation) this.#kernelCreations.delete(language);
		}
	}

	async complete(request: CompletionRequest, ctx: ExtensionContext): Promise<CompletionResult> {
		return await this.#options.complete(request, ctx);
	}

	bridgeEndpoint(): BridgeEndpoint {
		const bridge = this.#bridge;
		if (!bridge) throw new Error("codemode bridge server is not running");
		return { port: bridge.port, token: bridge.token };
	}

	setContext(ctx: ExtensionContext): void {
		this.#context = ctx;
	}

	dispose(): Promise<void> {
		if (this.#disposePromise) return this.#disposePromise;
		this.#generation++;
		this.#disposePromise = this.#disposeGeneration();
		return this.#disposePromise;
	}

	async #disposeGeneration(): Promise<void> {
		await Promise.allSettled(this.#kernelCreations.values());
		const kernels = [...this.#kernels.values()];
		const bridge = this.#bridge;
		this.#kernels.clear();
		this.#onMessageRefs.clear();
		this.#bridge = undefined;
		this.#context = undefined;
		const failures: unknown[] = [];
		for (const outcome of await Promise.allSettled(kernels.map((kernel) => kernel.close()))) {
			if (outcome.status === "rejected") failures.push(outcome.reason);
		}
		if (bridge) {
			const [outcome] = await Promise.allSettled([bridge.close()]);
			if (outcome?.status === "rejected") failures.push(outcome.reason);
		}
		if (failures.length > 0) {
			throw new AggregateError(failures, "Failed to dispose codemode session manager");
		}
	}

	async #createAndStoreKernel(
		language: EvalLanguage,
		onMessage: (message: KernelToHostMessage) => void,
		generation: number,
	): Promise<EvalKernel> {
		const kernel = await this.#createKernel(language, onMessage);
		if (generation !== this.#generation) {
			await kernel.close();
			throw new CodemodeSessionDisposedError();
		}
		this.#kernels.set(language, kernel);
		return kernel;
	}

	async #createKernel(language: EvalLanguage, onMessage: (message: KernelToHostMessage) => void): Promise<EvalKernel> {
		const bridge = this.#bridge;
		if (!bridge) throw new Error("codemode bridge server is not running");
		const configuredPoolWidth = this.#options.settings.parallelPoolWidth;
		const parallelPoolWidth = Number.isFinite(configuredPoolWidth) ? Math.max(1, Math.trunc(configuredPoolWidth)) : 1;
		// localRoots must be computed BEFORE the js branch: the JS kernel resolves local://
		// from its worker init connection exactly like the subprocess kernels resolve it from
		// theirs. Computing it after the early return left js cells with no local root at all.
		const localRoots =
			this.#options.localRoots ??
			(this.#options.artifactsDir ? { local: join(this.#options.artifactsDir, "local") } : undefined);
		if (language === "js") {
			return new JavaScriptKernel({
				sessionId: this.#options.sessionId,
				cwd: this.#options.cwd,
				parallelPoolWidth,
				onMessage,
				...(localRoots ? { localRoots: { ...localRoots } } : {}),
				...(this.#options.artifactsDir ? { artifactsDir: this.#options.artifactsDir } : {}),
			});
		}
		const detected = this.#options.availability[language].detected;
		if (!detected.ok) throw new Error(`No ${language} interpreter is available`);
		const connection = {
			port: bridge.port,
			token: bridge.token,
			parallelPoolWidth,
			...(localRoots ? { localRoots: { ...localRoots } } : {}),
			...(this.#options.artifactsDir ? { artifactsDir: this.#options.artifactsDir } : {}),
		};
		if (language === "py") {
			return await PythonKernel.start({
				interpreterPath: detected.path,
				sessionId: this.#options.sessionId,
				cwd: this.#options.cwd,
				connection,
				onMessage,
			});
		}
		if (language === "rb") {
			return RubyKernel.start({
				command: detected.path,
				sessionId: this.#options.sessionId,
				cwd: this.#options.cwd,
				connection,
				onMessage,
			});
		}
		return JuliaKernel.start({
			command: detected.path,
			sessionId: this.#options.sessionId,
			cwd: this.#options.cwd,
			connection,
			onMessage,
		});
	}

	#contextFor(signal: AbortSignal): ExtensionContext {
		const ctx = this.#context;
		if (!ctx) throw new CodemodeContextUnavailableError();
		return { ...ctx, signal: ctx.signal ? AbortSignal.any([ctx.signal, signal]) : signal };
	}
}
