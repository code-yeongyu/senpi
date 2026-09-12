import type { ToolDefinition } from "@code-yeongyu/senpi";
import { DEFAULT_FOREGROUND_WINDOW_SECONDS } from "../config/settings.ts";
import { buildEvalPrompt } from "../prompt/eval-prompt.ts";
import { EvalDetachedCellManager } from "./detached-cell-manager.ts";
import { detachedKernelBusyError, executeEvalControl } from "./detached-eval-result.ts";
import { clampEvalSummary, isEvalControlRequest, parseEvalRequest } from "./eval-request.ts";
import type { CreateEvalToolOptions } from "./eval-tool-options.ts";
import { runEvalCell } from "./run-eval-cell.ts";
import {
	createEvalInputSchema,
	defaultEvalDeadlineSeconds,
	type EvalInputSchema,
	type EvalToolDetails,
	type EvalToolRequest,
	enabledLanguageList,
} from "./types.ts";

export type { EvalTimeoutFactory } from "./cell-execution.ts";
export type { CreateEvalToolOptions } from "./eval-tool-options.ts";
export type { EnabledEvalLanguages, EvalKernel, EvalKernelManager } from "./types.ts";

export function createEvalTool(options: CreateEvalToolOptions): ToolDefinition<EvalInputSchema, EvalToolDetails> {
	const foregroundWindowSeconds = options.foregroundWindowSeconds ?? DEFAULT_FOREGROUND_WINDOW_SECONDS;
	const deadlines = {
		runBudgetSeconds: options.runBudgetSeconds ?? defaultEvalDeadlineSeconds.runBudgetSeconds,
		detachAfterSeconds: Math.min(options.cellTimeoutSeconds, foregroundWindowSeconds),
		foregroundWindowSeconds,
		hardLimitSeconds: options.hardLimitSeconds ?? defaultEvalDeadlineSeconds.hardLimitSeconds,
	};
	const parameters = createEvalInputSchema(options.enabledLanguages, deadlines);
	const prompt = buildEvalPrompt(options.enabledLanguages, {
		spawns: options.spawns ?? false,
		monitor: options.monitor,
		runBudgetSeconds: deadlines.runBudgetSeconds,
		...(options.spawnDefaultAgent === undefined ? {} : { spawnDefaultAgent: options.spawnDefaultAgent }),
		...(options.modelId === undefined ? {} : { modelId: options.modelId }),
		...(options.hostLine === undefined ? {} : { hostLine: options.hostLine }),
		...(options.runtimes?.js === undefined ? {} : { jsRuntime: options.runtimes.js }),
		...(options.bunSkillPath === undefined ? {} : { bunSkillPath: options.bunSkillPath }),
	});
	const languages = enabledLanguageList(options.enabledLanguages);
	const cellManager =
		options.cellManager ??
		new EvalDetachedCellManager({
			...(options.artifactsDir === undefined ? {} : { artifactsDir: options.artifactsDir }),
			...(options.hardLimitSeconds === undefined ? {} : { hardLimitSeconds: options.hardLimitSeconds }),
			...(options.runBudgetSeconds === undefined ? {} : { runBudgetSeconds: options.runBudgetSeconds }),
		});
	return {
		name: "eval",
		label: "Eval",
		description: prompt.description,
		promptSnippet: prompt.promptSnippet,
		promptGuidelines: [...prompt.promptGuidelines],
		parameters,
		executionMode: "sequential",
		prepareArguments: (args) => {
			if (typeof args !== "object" || args === null) return args as EvalToolRequest;
			const record = args as Record<string, unknown>;
			if (record.action === "peek" || record.action === "stop") return args as EvalToolRequest;
			const summary = clampEvalSummary(record.summary);
			if (summary === undefined) delete record.summary;
			else record.summary = summary;
			return args as EvalToolRequest;
		},
		...(options.renderers?.renderCall === undefined ? {} : { renderCall: options.renderers.renderCall }),
		...(options.renderers?.renderResult === undefined ? {} : { renderResult: options.renderers.renderResult }),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const request = parseEvalRequest(params);
			if (isEvalControlRequest(request)) return await executeEvalControl(cellManager, request);
			if (options.proxyExecutor) return await options.proxyExecutor(request, signal);
			if (!languages.includes(request.language))
				throw new RangeError(
					`Unsupported eval language "${request.language}". Enabled languages: ${languages.join(", ")}`,
				);
			const busy = cellManager.busyFor(request.language);
			if (busy !== undefined) {
				const idleLanguages = languages.filter(
					(language) => language !== request.language && cellManager.busyFor(language) === undefined,
				);
				throw detachedKernelBusyError(busy, idleLanguages);
			}
			options.executionTracker?.assertEvalExecutionAllowed();
			const lifecycleController = new AbortController();
			const combinedSignal = signal
				? AbortSignal.any([signal, lifecycleController.signal])
				: lifecycleController.signal;
			const execution = runEvalCell(options, cellManager, {
				cellId: toolCallId,
				input: request,
				signal: combinedSignal,
				onUpdate,
				ctx,
			});
			return options.executionTracker
				? await options.executionTracker.trackEvalExecution(execution, lifecycleController)
				: await execution;
		},
	};
}
