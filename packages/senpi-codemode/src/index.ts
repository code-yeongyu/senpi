import type { ExtensionAPI, ExtensionContext } from "@code-yeongyu/senpi";
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
import type { EvalKernel, EvalLanguage } from "./tool/types.ts";
import { evalLanguageOrder } from "./tool/types.ts";

export interface SenpiCodemodeOptions {
	readonly createSessionManager?: (
		options: CreateCodemodeSessionManagerOptions,
	) => CodemodeSessionManager | Promise<CodemodeSessionManager>;
	readonly complete?: (request: CompletionRequest, ctx: ExtensionContext) => Promise<CompletionResult>;
}

export default function senpiCodemode(pi: ExtensionAPI, options: SenpiCodemodeOptions = {}): void {
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
		await manager.replace(await createManager(pi, ctx, event, complete, options));
	});
	pi.on("session_shutdown", async () => manager.dispose());
	pi.on("session_before_switch", async () => manager.dispose());
	pi.on("session_before_fork", async () => manager.dispose());
}

class SessionManagerProxy implements CodemodeSessionManager {
	#current: CodemodeSessionManager | undefined;

	async replace(next: CodemodeSessionManager): Promise<void> {
		await this.dispose();
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
		const current = this.#current;
		this.#current = undefined;
		await current?.dispose();
	}
}

async function createManager(
	pi: ExtensionAPI,
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
	const enabled = {} as Record<EvalLanguage, boolean>;
	for (const language of evalLanguageOrder) {
		enabled[language] = settings.languages[language] && availability[language].detected.ok;
	}
	return enabled;
}
