import * as os from "node:os";
import type { ExtensionContext } from "@code-yeongyu/senpi";
import type { AgentExecuteTool } from "./bridges/agent-bridge.ts";
import type { EvalSchemaToolInfo } from "./bridges/schema-bridge.ts";
import { type CompletionRequest, type CompletionResult, createCompletionHandler } from "./completion/handler.ts";
import { defaultCodemodeSettings, resolveForegroundWindowSeconds, resolveHardLimitSeconds } from "./config/settings.ts";
import { EvalNotifier } from "./extension/eval-notifier.ts";
import { EVAL_CELLS_STATUS_KEY } from "./extension/eval-status.ts";
import { EvalStatusTicker } from "./extension/eval-status-ticker.ts";
import {
	createExecuteTool,
	createRuntime,
	enabledLanguagesFrom,
	type SessionRuntime,
} from "./extension/runtime-factory.ts";
import { jsRuntimeInfo, jsRuntimeLabel } from "./extension/runtime-info.ts";
import type { CodemodeSessionManager, CreateCodemodeSessionManagerOptions } from "./extension/session-manager.ts";
import { SessionManagerProxy } from "./extension/session-manager-proxy.ts";
import { activeBunSkillPath, registerBunSkillContribution } from "./extension/skill-contribution.ts";
import { WAKE_SOURCE_STATE_EVENT, type WakeSourceState } from "./extension/wake-source-state.ts";
import { EvalDetachedCellManager, type EvalDetachedCellStatusEntry } from "./tool/detached-cell-manager.ts";
import {
	EVAL_EXECUTION_EVENT,
	type EvalExecutionEventPayload,
	toEvalExecutionRpcPayload,
} from "./tool/eval-execution-event.ts";
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
	on(event: CodemodeEvent | "resources_discover", handler: (event: unknown, ctx: ExtensionContext) => unknown): void;
	executeTool: AgentExecuteTool;
	getActiveTools(): string[];
	getAllTools(): readonly EvalSchemaToolInfo[];
	sendMessage(
		message: { customType: string; content: string; display: boolean },
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void;
	/** Optional host event bus; a host without one turns extension event emission into a harmless no-op. */
	events?: { emit(name: string, data: unknown): void };
	/** Optional host RPC surface for forwarding extension-owned events to connected clients. */
	rpc?: { emit(name: string, data: unknown): void };
}

export interface SenpiCodemodeOptions {
	readonly createSessionManager?: (
		options: CreateCodemodeSessionManagerOptions,
	) => CodemodeSessionManager | Promise<CodemodeSessionManager>;
	readonly complete?: (request: CompletionRequest, ctx: ExtensionContext) => Promise<CompletionResult>;
	/** Injectable clock for detached-cell elapsed labels; defaults to Date.now. */
	readonly now?: () => number;
}

/** Whether the session registry holds `monitor`; false when the runtime cannot be read yet. */
function monitorIsRegistered(pi: CodemodeExtensionAPI): boolean {
	try {
		return pi.getAllTools().some((tool) => tool.name === "monitor");
	} catch {
		return false;
	}
}

export default function senpiCodemode(pi: CodemodeExtensionAPI, options: SenpiCodemodeOptions = {}): void {
	const manager = new SessionManagerProxy();
	const complete = options.complete ?? ((request, ctx) => createCompletionHandler()(ctx)(request));
	const renderers = { renderCall: renderEvalCall, renderResult: renderEvalResult };
	const bunSkillPath = activeBunSkillPath();
	let activeRuntime: SessionRuntime | undefined;
	let activeModelId: string | undefined;
	let activeContext: ExtensionContext | undefined;
	let activeCells: EvalDetachedCellManager | undefined;
	const notifier = new EvalNotifier({
		sendMessage: (message, notifyOptions) => pi.sendMessage(message, notifyOptions),
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
	const emitWakeSourceState = (state: WakeSourceState): void => {
		pi.events?.emit(WAKE_SOURCE_STATE_EVENT, state);
	};
	const registerEvalForRuntime = (
		runtime: SessionRuntime,
		modelId: string | undefined,
		cellManager: EvalDetachedCellManager,
	): void => {
		const onCellSettled = (payload: EvalExecutionEventPayload): void => {
			if (activeCells !== cellManager) return;
			pi.rpc?.emit(EVAL_EXECUTION_EVENT, toEvalExecutionRpcPayload(payload));
			pi.events?.emit(EVAL_EXECUTION_EVENT, payload);
		};
		// `listTools` below survives because it is lazy; this read is eager, and the loader's
		// action methods throw while extensions are still loading (the bundled codemode path
		// reaches this before the runtime is bound). An unreadable registry means "do not teach
		// a tool we cannot confirm"; session_start / model_select re-register once it is live.
		const monitor = monitorIsRegistered(pi);
		pi.registerTool(
			createEvalTool({
				enabledLanguages: runtime.enabledLanguages,
				kernelManager: manager,
				cellTimeoutSeconds: runtime.settings.cellTimeoutSeconds,
				foregroundWindowSeconds: resolveForegroundWindowSeconds(runtime.settings),
				executeTool: runtime.executeTool,
				listTools: () => pi.getAllTools(),
				complete,
				settings: runtime.settings,
				artifactsDir: runtime.artifactsDir,
				cellManager,
				executionTracker: manager,
				onCellSettled,
				renderers,
				monitor,
				spawns: runtime.spawns,
				spawnDefaultAgent: runtime.settings.taskTools.task,
				hostLine: hostLine(),
				runtimes: runtime.runtimes,
				...(bunSkillPath === undefined ? {} : { bunSkillPath }),
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
			foregroundWindowSeconds: resolveForegroundWindowSeconds(defaultCodemodeSettings),
			executeTool: createExecuteTool(pi),
			listTools: () => pi.getAllTools(),
			complete,
			settings: defaultCodemodeSettings,
			cellManager: new EvalDetachedCellManager({
				notifier,
				hardLimitSeconds: resolveHardLimitSeconds(defaultCodemodeSettings),
				onStatusChange: showDetachedCells,
				onWakeSourceState: emitWakeSourceState,
				...(options.now === undefined ? {} : { now: options.now }),
			}),
			executionTracker: manager,
			renderers,
			// The baseline tool is registered before extensions such as monitor load.
			monitor: false,
			hostLine: hostLine(),
			runtimes: { js: jsRuntimeInfo() },
			...(bunSkillPath === undefined ? {} : { bunSkillPath }),
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
	registerBunSkillContribution(pi);

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
			hardLimitSeconds: resolveHardLimitSeconds(runtime.settings),
			onStatusChange: showDetachedCells,
			onWakeSourceState: emitWakeSourceState,
			...(options.now === undefined ? {} : { now: options.now }),
		});
		activeCells = cellManager;
		// The goal builtin clears its per-session counts at session_start; re-publish our snapshot.
		cellManager.publishWakeSourceState();
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
	return [`${os.platform()} ${os.arch()}`, cpu, `${os.availableParallelism()} cores`, jsRuntimeLabel()]
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
