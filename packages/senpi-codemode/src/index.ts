import * as os from "node:os";
import type { ExtensionContext } from "@code-yeongyu/senpi";
import type { AgentExecuteTool } from "./bridges/agent-bridge.ts";
import { CodeModeSessionRuntime } from "./codemode/runtime.ts";
import { type CodeModeTool, createCodeModeTools, isGptCodeModeModel } from "./codemode/tools.ts";
import { type CompletionRequest, type CompletionResult, createCompletionHandler } from "./completion/handler.ts";
import { defaultCodemodeSettings } from "./config/settings.ts";
import {
	createExecuteTool,
	createRuntime,
	enabledLanguagesFrom,
	type SessionRuntime,
} from "./extension/runtime-factory.ts";
import type { CodemodeSessionManager, CreateCodemodeSessionManagerOptions } from "./extension/session-manager.ts";
import { SessionManagerProxy } from "./extension/session-manager-proxy.ts";
import { createEvalTool } from "./tool/eval-tool.ts";
import { renderEvalCall, renderEvalResult } from "./tool/render.ts";

const SESSION_LIFECYCLE_EVENTS = [
	"session_start",
	"session_shutdown",
	"session_before_switch",
	"session_before_fork",
] as const;

type SessionLifecycleEvent = (typeof SESSION_LIFECYCLE_EVENTS)[number];

type CodemodeEvent = SessionLifecycleEvent | "model_select";

export interface CodemodeExtensionAPI {
	registerTool(tool: ReturnType<typeof createEvalTool>): void;
	on(event: CodemodeEvent, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void): void;
	executeTool: AgentExecuteTool;
	getActiveTools(): string[];
	setActiveTools?(toolNames: string[]): void | Promise<void>;
	getAllTools?(): readonly { readonly name: string }[];
}

export interface SenpiCodemodeOptions {
	readonly createSessionManager?: (
		options: CreateCodemodeSessionManagerOptions,
	) => CodemodeSessionManager | Promise<CodemodeSessionManager>;
	readonly complete?: (request: CompletionRequest, ctx: ExtensionContext) => Promise<CompletionResult>;
}

type DynamicCodeModeExtensionAPI = CodemodeExtensionAPI & {
	registerTool(tool: CodeModeTool): void;
	setActiveTools(toolNames: string[]): void | Promise<void>;
	getAllTools(): readonly { readonly name: string }[];
};

export default function senpiCodemode(pi: CodemodeExtensionAPI, options: SenpiCodemodeOptions = {}): void {
	const manager = new SessionManagerProxy();
	const complete = options.complete ?? ((request, ctx) => createCompletionHandler()(ctx)(request));
	const renderers = { renderCall: renderEvalCall, renderResult: renderEvalResult };
	let activeRuntime: (SessionRuntime & { readonly codeMode?: CodeModeSessionRuntime }) | undefined;
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
				hostLine: hostLine(),
				...(modelId === undefined ? {} : { modelId }),
			}),
		);
	};
	const dropRuntime = async (): Promise<void> => {
		const codeMode = activeRuntime?.codeMode;
		activeRuntime = undefined;
		activeModelId = undefined;
		await Promise.all([manager.dispose(), codeMode?.dispose()]);
	};
	const activateCodeModeTools = async (runtime: CodeModeSessionRuntime): Promise<void> => {
		if (!isDynamicCodeModeExtensionAPI(pi)) return;
		const tools = createCodeModeTools({ runtime });
		pi.registerTool(tools.exec);
		pi.registerTool(tools.wait);
		await pi.setActiveTools([...new Set([...pi.getActiveTools(), "exec", "wait"])]);
	};
	const deactivateCodeModeTools = async (): Promise<void> => {
		if (!isDynamicCodeModeExtensionAPI(pi)) return;
		await pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "exec" && name !== "wait"));
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
			hostLine: hostLine(),
		}),
	);

	pi.on("session_start", async (event, ctx) => {
		const previousCodeMode = activeRuntime?.codeMode;
		const generation = manager.beginReplacement();
		const runtime = await createRuntime(pi, ctx, event, complete, options);
		const replaced = await manager.replace(generation, runtime.manager);
		if (!replaced) return;
		await previousCodeMode?.dispose();
		const codeMode = isGptCodeModeModel(ctx.model?.id)
			? new CodeModeSessionRuntime({
					sessionId: runtime.sessionId,
					cwd: runtime.cwd,
					parallelPoolWidth: runtime.parallelPoolWidth,
					executeTool: runtime.executeTool,
				})
			: undefined;
		activeRuntime = { ...runtime, ...(codeMode === undefined ? {} : { codeMode }) };
		activeModelId = ctx.model?.id;
		registerEvalForRuntime(activeRuntime, activeModelId);
		if (codeMode) await activateCodeModeTools(codeMode);
		else await deactivateCodeModeTools();
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
		if (!isGptCodeModeModel(modelId)) {
			const { codeMode, ...nextRuntime } = runtime;
			await codeMode?.dispose();
			activeRuntime = nextRuntime;
			await deactivateCodeModeTools();
			return;
		}
		if (runtime.codeMode) {
			if (isDynamicCodeModeExtensionAPI(pi)) {
				await pi.setActiveTools([...new Set([...pi.getActiveTools(), "exec", "wait"])]);
			}
			return;
		}
		const codeMode = new CodeModeSessionRuntime({
			sessionId: runtime.sessionId,
			cwd: runtime.cwd,
			parallelPoolWidth: runtime.parallelPoolWidth,
			executeTool: runtime.executeTool,
		});
		activeRuntime = { ...runtime, codeMode };
		await activateCodeModeTools(codeMode);
	});
}

function isDynamicCodeModeExtensionAPI(pi: CodemodeExtensionAPI): pi is DynamicCodeModeExtensionAPI {
	return typeof pi.setActiveTools === "function" && typeof pi.getAllTools === "function";
}

function hostLine(): string {
	const cpu = os.cpus()[0]?.model?.trim();
	return [`${os.platform()} ${os.arch()}`, cpu, `${os.availableParallelism()} cores`]
		.filter((part): part is string => !!part)
		.join(" \u00b7 ");
}

function modelIdFrom(event: unknown): string | undefined {
	if (typeof event !== "object" || event === null || !("model" in event)) return undefined;
	const model = event.model;
	if (typeof model !== "object" || model === null || !("id" in model)) return undefined;
	return typeof model.id === "string" ? model.id : undefined;
}

export { enabledLanguagesFrom };
