import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@code-yeongyu/senpi";
import { defaultCodemodeSettings } from "../config/settings.ts";
import { buildEvalPrompt } from "../prompt/eval-prompt.ts";
import { TIMEOUT_PAUSE_OP, TIMEOUT_RESUME_OP } from "../timeouts/bridge-timeout.ts";
import { abortError, CellExecution, defaultTimeoutFactory } from "./cell-execution.ts";
import { CellHandler, type CellState } from "./cell-handler.ts";
import { EvalDetachedCellManager } from "./detached-cell-manager.ts";
import { detachedKernelBusyError, executeEvalControl, resultAfterDetach } from "./detached-eval-result.ts";
import { evalTimeoutBehavior, isEvalControlRequest, parseEvalRequest } from "./eval-request.ts";
import type { CreateEvalToolOptions, EvalCellInvocation } from "./eval-tool-options.ts";
import { describeTimeoutState } from "./interrupt-note.ts";
import { createEvalInputSchema, type EvalInputSchema, type EvalToolDetails, enabledLanguageList } from "./types.ts";

export type { EvalTimeoutFactory } from "./cell-execution.ts";
export type { CreateEvalToolOptions } from "./eval-tool-options.ts";
export type { EnabledEvalLanguages, EvalKernel, EvalKernelManager } from "./types.ts";

export function createEvalTool(options: CreateEvalToolOptions): ToolDefinition<EvalInputSchema, EvalToolDetails> {
	const parameters = createEvalInputSchema(options.enabledLanguages);
	const prompt = buildEvalPrompt(options.enabledLanguages, {
		spawns: options.spawns ?? false,
		...(options.spawnDefaultAgent === undefined ? {} : { spawnDefaultAgent: options.spawnDefaultAgent }),
		...(options.modelId === undefined ? {} : { modelId: options.modelId }),
		...(options.hostLine === undefined ? {} : { hostLine: options.hostLine }),
	});
	const languages = enabledLanguageList(options.enabledLanguages);
	const cellManager = options.cellManager ?? new EvalDetachedCellManager({ artifactsDir: options.artifactsDir });
	return {
		name: "eval",
		label: "Eval",
		description: prompt.description,
		promptSnippet: prompt.promptSnippet,
		promptGuidelines: [...prompt.promptGuidelines],
		parameters,
		executionMode: "sequential",
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
			if (busy !== undefined) throw detachedKernelBusyError(busy);
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

async function runEvalCell(
	options: CreateEvalToolOptions,
	cellManager: EvalDetachedCellManager,
	invocation: EvalCellInvocation,
): Promise<AgentToolResult<EvalToolDetails>> {
	if (invocation.signal.aborted) throw abortError(invocation.signal.reason);
	const timeoutMs = Math.floor((invocation.input.timeout ?? options.cellTimeoutSeconds) * 1_000);
	const timeoutBehavior = evalTimeoutBehavior(invocation.input, invocation.ctx);
	const bridgeAbortController = new AbortController();
	const cellSignal = AbortSignal.any([invocation.signal, bridgeAbortController.signal]);
	const bridgeContext: ExtensionContext = { ...invocation.ctx, signal: cellSignal };
	const state: CellState = {
		input: invocation.input,
		signal: cellSignal,
		onUpdate: invocation.onUpdate,
		toolCalls: [],
		pendingBridgeCalls: [],
		statusEvents: [],
		active: true,
		output: "",
		phase: undefined,
		durationMs: 0,
		status: "pending",
	};
	const cell = cellManager.create(invocation.cellId, invocation.input);
	let execution: CellExecution;
	execution = new CellExecution({
		callerSignal: invocation.signal,
		cellId: invocation.cellId,
		timeoutMs,
		timeoutFactory: options.timeoutFactory ?? defaultTimeoutFactory,
		onTimeout: (error) => {
			if (timeoutBehavior === "detach" && cellManager.detach(cell)) {
				execution.detach();
				return;
			}
			execution.cancel(error);
		},
		onAbort: (error) => {
			state.active = false;
			bridgeAbortController.abort(error);
		},
	});
	const running = executeCell(
		options,
		invocation,
		cellManager,
		cell,
		state,
		execution,
		bridgeContext,
		bridgeAbortController,
	);
	const finalized = running.then(
		(result) => {
			cellManager.complete(cell, result);
			return result;
		},
		(error: unknown) => {
			cellManager.fail(cell, error instanceof Error ? error : new Error(String(error)));
			throw error;
		},
	);
	const outcome = await Promise.race([
		finalized.then((result) => ({ kind: "result" as const, result })),
		execution.detached.then(() => ({ kind: "detached" as const })),
	]);
	if (outcome.kind === "detached") return resultAfterDetach(cellManager.peek(invocation.cellId), invocation.input);
	return outcome.result;
}

async function executeCell(
	options: CreateEvalToolOptions,
	invocation: EvalCellInvocation,
	cellManager: EvalDetachedCellManager,
	cell: Parameters<EvalDetachedCellManager["markRunning"]>[0],
	state: CellState,
	execution: CellExecution,
	bridgeContext: ExtensionContext,
	bridgeAbortController: AbortController,
): Promise<AgentToolResult<EvalToolDetails>> {
	let handler: CellHandler | undefined;
	try {
		const kernel = await execution.wait(
			options.kernelManager.getKernel(invocation.input.language, (message) => {
				if (!state.active || handler === undefined) return;
				if (message.type === "status") {
					if (message.event.op === TIMEOUT_PAUSE_OP) {
						execution.pause();
						return;
					}
					if (message.event.op === TIMEOUT_RESUME_OP) {
						execution.resume();
						return;
					}
				}
				const pending = handler.handle(message);
				void pending.catch((error: unknown) => execution.cancel(error));
			}),
		);
		execution.setKernel(kernel);
		const activeHandler = new CellHandler(kernel, state, {
			executeTool: options.executeTool,
			...(options.listTools === undefined ? {} : { listTools: options.listTools }),
			settings: options.settings ?? defaultCodemodeSettings,
			...(options.complete === undefined ? {} : { complete: options.complete }),
			ctx: bridgeContext,
			...(options.artifactsDir === undefined
				? {}
				: { artifactPath: join(options.artifactsDir, `eval-${randomUUID()}.log`) }),
			...(options.imageResizer === undefined ? {} : { imageResizer: options.imageResizer }),
		});
		handler = activeHandler;
		cellManager.markRunning(cell, kernel, () => activeHandler.liveResult());
		if ("setContext" in options.kernelManager && typeof options.kernelManager.setContext === "function") {
			options.kernelManager.setContext(bridgeContext);
		}
		if (invocation.input.reset) await execution.wait(kernel.reset());
		const result = await execution.wait(kernel.run({ cellId: invocation.cellId, code: invocation.input.code }));
		if (result.ok && state.pendingBridgeCalls.length > 0) await execution.wait(Promise.all(state.pendingBridgeCalls));
		return await handler.finalize(result);
	} catch (error) {
		if (handler && error instanceof Error && error.name === "CodemodeSessionDisposedError")
			return await handler.finalizeCancellation(error);
		if (error instanceof Error && error.name === "TimeoutError") throw await describeTimeoutState(error, execution);
		throw error;
	} finally {
		state.active = false;
		bridgeAbortController.abort();
		execution.finish();
		if (handler) await handler.flushOutput();
	}
}
