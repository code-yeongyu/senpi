import type { ExtensionContext } from "@code-yeongyu/senpi";
import { type BridgeServerHandle, startBridgeServer } from "../bridge/http-server.ts";
import type { KernelToHostMessage } from "../bridge/protocol.ts";
import type { CompletionRequest, CompletionResult } from "../completion/handler.ts";
import type { CodemodeSettings } from "../config/settings.ts";
import type { InterpreterAvailability } from "../interpreters/detect.ts";
import { JuliaKernel } from "../kernels/jl/kernel.ts";
import { JavaScriptKernel } from "../kernels/js/context-manager.ts";
import { PythonKernel } from "../kernels/py/kernel.ts";
import { RubyKernel } from "../kernels/rb/kernel.ts";
import type { EvalKernel, EvalKernelManager, EvalLanguage, ExecuteTool } from "../tool/types.ts";

export interface CodemodeSessionManager extends EvalKernelManager {
	dispose(): Promise<void>;
	complete(request: CompletionRequest, ctx: ExtensionContext): Promise<CompletionResult>;
	setContext?(ctx: ExtensionContext): void;
}

export interface CreateCodemodeSessionManagerOptions {
	readonly sessionId: string;
	readonly cwd: string;
	readonly settings: CodemodeSettings;
	readonly availability: InterpreterAvailability;
	readonly executeTool: ExecuteTool;
	readonly complete: (request: CompletionRequest, ctx: ExtensionContext) => Promise<CompletionResult>;
}

export async function createCodemodeSessionManager(
	options: CreateCodemodeSessionManagerOptions,
): Promise<CodemodeSessionManager> {
	const manager = new DefaultCodemodeSessionManager(options);
	await manager.start();
	return manager;
}

class DefaultCodemodeSessionManager implements CodemodeSessionManager {
	readonly #options: CreateCodemodeSessionManagerOptions;
	#bridge: BridgeServerHandle | undefined;
	#kernels = new Map<EvalLanguage, EvalKernel>();
	#context: ExtensionContext | undefined;

	constructor(options: CreateCodemodeSessionManagerOptions) {
		this.#options = options;
	}

	async start(): Promise<void> {
		this.#bridge = await startBridgeServer({
			onCall: async (request) =>
				this.#options.executeTool(request.toolName, request.args, { signal: request.signal }),
			onEmit: async () => undefined,
			onCompletion: async (request) =>
				this.#options.complete({ prompt: request.prompt, opts: request.opts }, this.#contextFor(request.signal)),
		});
	}

	async getKernel(language: EvalLanguage, onMessage: (message: KernelToHostMessage) => void): Promise<EvalKernel> {
		const existing = this.#kernels.get(language);
		if (existing) return existing;
		const kernel = await this.#createKernel(language, onMessage);
		this.#kernels.set(language, kernel);
		return kernel;
	}

	async complete(request: CompletionRequest, ctx: ExtensionContext): Promise<CompletionResult> {
		return await this.#options.complete(request, ctx);
	}

	setContext(ctx: ExtensionContext): void {
		this.#context = ctx;
	}

	async dispose(): Promise<void> {
		const kernels = [...this.#kernels.values()];
		this.#kernels.clear();
		await Promise.all(kernels.map((kernel) => kernel.close()));
		await this.#bridge?.close();
		this.#bridge = undefined;
	}

	async #createKernel(language: EvalLanguage, onMessage: (message: KernelToHostMessage) => void): Promise<EvalKernel> {
		const bridge = this.#bridge;
		if (!bridge) throw new Error("codemode bridge server is not running");
		if (language === "js") {
			return new JavaScriptKernel({
				sessionId: this.#options.sessionId,
				cwd: this.#options.cwd,
				parallelPoolWidth: this.#options.settings.parallelPoolWidth,
				onMessage,
			});
		}
		const detected = this.#options.availability[language].detected;
		if (!detected.ok) throw new Error(`No ${language} interpreter is available`);
		const connection = { port: bridge.port, token: bridge.token };
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
		if (!ctx) return { signal } as ExtensionContext;
		return ctx;
	}
}
