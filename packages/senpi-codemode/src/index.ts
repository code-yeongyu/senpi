import type { ExtensionContext } from "@code-yeongyu/senpi";
import type { KernelToHostMessage } from "./bridge/protocol.ts";
import { type CompletionRequest, type CompletionResult, createCompletionHandler } from "./completion/handler.ts";
import { type CodemodeSettings, loadCodemodeSettings } from "./config/settings.ts";
import {
	type CodemodeSessionManager,
	type CreateCodemodeSessionManagerOptions,
	createCodemodeSessionManager,
} from "./extension/session-manager.ts";
import {
	createInterpreterDetector,
	getInterpreterAvailability,
	type InterpreterAvailability,
} from "./interpreters/detect.ts";
import { createEvalTool } from "./tool/eval-tool.ts";
import type { EvalKernel, EvalLanguage, ExecuteTool } from "./tool/types.ts";

type SessionLifecycleEvent = "session_start" | "session_shutdown" | "session_before_switch" | "session_before_fork";

export interface CodemodeExtensionAPI {
	registerTool(tool: ReturnType<typeof createEvalTool>): void;
	on(event: SessionLifecycleEvent, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void): void;
	executeTool: ExecuteTool;
}

export interface SenpiCodemodeOptions {
	readonly createSessionManager?: (
		options: CreateCodemodeSessionManagerOptions,
	) => CodemodeSessionManager | Promise<CodemodeSessionManager>;
	readonly complete?: (request: CompletionRequest, ctx: ExtensionContext) => Promise<CompletionResult>;
}

export default function senpiCodemode(pi: CodemodeExtensionAPI, options: SenpiCodemodeOptions = {}): void {
	const manager = new SessionManagerProxy();
	const complete = options.complete ?? ((request, ctx) => createCompletionHandler()(ctx)(request));
	pi.registerTool(
		createEvalTool({
			enabledLanguages: { py: true, js: true, rb: true, jl: true },
			kernelManager: manager,
			cellTimeoutSeconds: 30,
			executeTool: (toolName, params, executeOptions) => pi.executeTool(toolName, params, executeOptions),
			complete,
		}),
	);

	pi.on("session_start", async (event, ctx) => {
		const generation = manager.beginReplacement();
		await manager.replace(generation, await createManager(pi, ctx, event, complete, options));
	});
	pi.on("session_shutdown", async () => manager.dispose());
	pi.on("session_before_switch", async () => manager.dispose());
	pi.on("session_before_fork", async () => manager.dispose());
}

class SessionManagerProxy implements CodemodeSessionManager {
	#current: CodemodeSessionManager | undefined;
	#generation = 0;

	beginReplacement(): number {
		this.#generation++;
		return this.#generation;
	}

	async replace(generation: number, next: CodemodeSessionManager): Promise<void> {
		if (generation !== this.#generation) {
			await next.dispose();
			return;
		}
		const current = this.#current;
		this.#current = undefined;
		await current?.dispose();
		if (generation !== this.#generation) {
			await next.dispose();
			return;
		}
		this.#current = next;
	}

	async getKernel(language: EvalLanguage, onMessage: (message: KernelToHostMessage) => void): Promise<EvalKernel> {
		if (!this.#current) throw new Error("codemode session has not started");
		return await this.#current.getKernel(language, onMessage);
	}

	async complete(request: CompletionRequest, ctx: ExtensionContext): Promise<CompletionResult> {
		if (!this.#current) throw new Error("codemode session has not started");
		return await this.#current.complete(request, ctx);
	}

	setContext(ctx: ExtensionContext): void {
		this.#current?.setContext?.(ctx);
	}

	async dispose(): Promise<void> {
		this.#generation++;
		const current = this.#current;
		this.#current = undefined;
		await current?.dispose();
	}
}

async function createManager(
	pi: CodemodeExtensionAPI,
	ctx: ExtensionContext,
	event: unknown,
	complete: (request: CompletionRequest, ctx: ExtensionContext) => Promise<CompletionResult>,
	options: SenpiCodemodeOptions,
): Promise<CodemodeSessionManager> {
	const loaded = await loadCodemodeSettings({ cwd: ctx.cwd });
	const availability = await getInterpreterAvailability(loaded.settings, createInterpreterDetector());
	const create = options.createSessionManager ?? createCodemodeSessionManager;
	return await create({
		sessionId: sessionIdFrom(event),
		cwd: ctx.cwd,
		settings: loaded.settings,
		availability,
		executeTool: (toolName, params, executeOptions) => pi.executeTool(toolName, params, executeOptions),
		complete,
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
