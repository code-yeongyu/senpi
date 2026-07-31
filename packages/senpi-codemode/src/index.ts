import * as os from "node:os";
import type { ExtensionContext } from "@code-yeongyu/senpi";
import type { AgentExecuteTool } from "./bridges/agent-bridge.ts";
import type { EvalSchemaToolInfo } from "./bridges/schema-bridge.ts";
import { type CompletionRequest, type CompletionResult, createCompletionHandler } from "./completion/handler.ts";
import { defaultCodemodeSettings } from "./config/settings.ts";
import { EvalNotifier } from "./extension/eval-notifier.ts";
import { EVAL_CELLS_STATUS_KEY } from "./extension/eval-status.ts";
import { EvalStatusTicker } from "./extension/eval-status-ticker.ts";
import {
	createExecuteTool,
	createRuntime,
	enabledLanguagesFrom,
	type SessionRuntime,
} from "./extension/runtime-factory.ts";
import type { CodemodeSessionManager, CreateCodemodeSessionManagerOptions } from "./extension/session-manager.ts";
import { SessionManagerProxy } from "./extension/session-manager-proxy.ts";
import { EvalDetachedCellManager, type EvalDetachedCellStatusEntry } from "./tool/detached-cell-manager.ts";
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
	registerRemovedToolHint(name: string, hint: string): void;
	on(event: CodemodeEvent, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void): void;
	executeTool: AgentExecuteTool;
	getActiveTools(): string[];
	getAllTools(): readonly EvalSchemaToolInfo[];
	sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): void;
}

export interface SenpiCodemodeOptions {
	readonly createSessionManager?: (
		options: CreateCodemodeSessionManagerOptions,
	) => CodemodeSessionManager | Promise<CodemodeSessionManager>;
	readonly complete?: (request: CompletionRequest, ctx: ExtensionContext) => Promise<CompletionResult>;
	/** Injectable clock for detached-cell elapsed labels; defaults to Date.now. */
	readonly now?: () => number;
}

export default function senpiCodemode(pi: CodemodeExtensionAPI, options: SenpiCodemodeOptions = {}): void {
	const manager = new SessionManagerProxy();
	const complete = options.complete ?? ((request, ctx) => createCompletionHandler()(ctx)(request));
	const renderers = { renderCall: renderEvalCall, renderResult: renderEvalResult };
	let activeRuntime: SessionRuntime | undefined;
	let activeModelId: string | undefined;
	let activeContext: ExtensionContext | undefined;
	let activeCells: EvalDetachedCellManager | undefined;
	const notifier = new EvalNotifier({
		sendUserMessage: (content, notifyOptions) => pi.sendUserMessage(content, notifyOptions),
		getContext: () => activeContext,
		getMode: () => "wake",
	});
	const statusTicker = new EvalStatusTicker({
		...(options.now === undefined ? {} : { now: options.now }),
		render: (status) => {
			const ctx = activeContext;
			if (ctx?.ui?.setStatus === undefined) return;
			const theme = ctx.ui.theme;
			ctx.ui.setStatus(
				EVAL_CELLS_STATUS_KEY,
				status === undefined || ctx.mode !== "tui" || theme === undefined
					? status
					: theme.bg("selectedBg", theme.fg("text", status)),
			);
		},
	});
	const showDetachedCells = (entries: readonly EvalDetachedCellStatusEntry[]): void => {
		statusTicker.sync(entries);
	};
	const registerEvalForRuntime = (
		runtime: SessionRuntime,
		modelId: string | undefined,
		cellManager: EvalDetachedCellManager,
	): void => {
		pi.registerTool(
			createEvalTool({
				enabledLanguages: runtime.enabledLanguages,
				kernelManager: manager,
				cellTimeoutSeconds: runtime.settings.cellTimeoutSeconds,
				executeTool: runtime.executeTool,
				listTools: () => pi.getAllTools(),
				complete,
				settings: runtime.settings,
				artifactsDir: runtime.artifactsDir,
				cellManager,
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
		const cells = activeCells;
		activeRuntime = undefined;
		activeModelId = undefined;
		activeCells = undefined;
		statusTicker.stop();
		await cells?.dispose();
		activeContext = undefined;
		await manager.dispose();
	};
	pi.registerTool(
		createEvalTool({
			enabledLanguages: { py: true, js: true, rb: true, jl: true },
			kernelManager: manager,
			cellTimeoutSeconds: defaultCodemodeSettings.cellTimeoutSeconds,
			executeTool: createExecuteTool(pi),
			listTools: () => pi.getAllTools(),
			complete,
			settings: defaultCodemodeSettings,
			cellManager: new EvalDetachedCellManager({
				notifier,
				onStatusChange: showDetachedCells,
				...(options.now === undefined ? {} : { now: options.now }),
			}),
			executionTracker: manager,
			renderers,
			hostLine: hostLine(),
		}),
	);
	pi.registerRemovedToolHint(
		"exec",
		'exec was removed; use eval({ language: "js", code }) instead. Long eval cells detach on timeout and notify when complete.',
	);
	pi.registerRemovedToolHint(
		"wait",
		'wait was removed; detached eval cells notify when complete. Use eval({ action: "peek"|"stop", cell_id }) to inspect or stop one.',
	);

	pi.on("session_start", async (event, ctx) => {
		const previousCells = activeCells;
		activeCells = undefined;
		await previousCells?.dispose();
		const generation = manager.beginReplacement();
		const runtime = await createRuntime(pi, ctx, event, complete, options);
		const replaced = await manager.replace(generation, runtime.manager);
		if (!replaced) return;
		notifier.reset();
		activeContext = ctx;
		const cellManager = new EvalDetachedCellManager({
			artifactsDir: runtime.artifactsDir,
			notifier,
			onStatusChange: showDetachedCells,
			...(options.now === undefined ? {} : { now: options.now }),
		});
		activeCells = cellManager;
		activeRuntime = runtime;
		activeModelId = ctx.model?.id;
		registerEvalForRuntime(runtime, activeModelId, cellManager);
	});
	pi.on("session_shutdown", async () => dropRuntime());
	pi.on("session_before_switch", async () => dropRuntime());
	pi.on("session_before_fork", async () => dropRuntime());
	pi.on("model_select", async (event, ctx) => {
		activeContext = ctx;
		const runtime = activeRuntime;
		if (runtime === undefined) return;
		const modelId = modelIdFrom(event);
		if (modelId === undefined || modelId === activeModelId) return;
		activeModelId = modelId;
		const cellManager = activeCells;
		if (cellManager === undefined) return;
		registerEvalForRuntime(runtime, modelId, cellManager);
	});
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
