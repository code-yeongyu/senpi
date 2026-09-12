import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AgentToolResult, ExtensionContext } from "@code-yeongyu/senpi";
import { DEFAULT_FOREGROUND_WINDOW_SECONDS, defaultCodemodeSettings } from "../config/settings.ts";
import { TIMEOUT_PAUSE_OP, TIMEOUT_RESUME_OP } from "../timeouts/bridge-timeout.ts";
import { abortError, CellExecution, defaultTimeoutFactory } from "./cell-execution.ts";
import { CellHandler, type CellState } from "./cell-handler.ts";
import type { EvalDetachedCellManager } from "./detached-cell-manager.ts";
import { resultAfterDetach } from "./detached-eval-result.ts";
import { buildEvalExecutionEventPayload, type EvalExecutionSettleOutcome } from "./eval-execution-event.ts";
import { evalTimeoutBehavior } from "./eval-request.ts";
import type { CreateEvalToolOptions, EvalCellInvocation } from "./eval-tool-options.ts";
import { describeTimeoutState } from "./interrupt-note.ts";
import type { EvalToolDetails } from "./types.ts";

export async function runEvalCell(
	options: CreateEvalToolOptions,
	cellManager: EvalDetachedCellManager,
	invocation: EvalCellInvocation,
): Promise<AgentToolResult<EvalToolDetails>> {
	if (invocation.signal.aborted) throw abortError(invocation.signal.reason);
	const detaches = evalTimeoutBehavior(invocation.input, invocation.ctx) === "detach";
	// The per-call `timeout` is the cell's run budget (owned by the cell manager's deadlines); how long
	// an interactive call blocks the turn is the idle detach budget, capped at the foreground window
	// — including the grace a bridge-parked cell gets — so `timeout` never delays the detach.
	const foregroundWindowMs = (options.foregroundWindowSeconds ?? DEFAULT_FOREGROUND_WINDOW_SECONDS) * 1_000;
	const detachAfterMs = Math.min(Math.floor(options.cellTimeoutSeconds * 1_000), foregroundWindowMs);
	const bridgeAbortController = new AbortController();
	const cellSignal = AbortSignal.any([invocation.signal, bridgeAbortController.signal]);
	const bridgeContext: ExtensionContext = { ...invocation.ctx, signal: cellSignal };
	const runtime = options.runtimes?.[invocation.input.language];
	const state: CellState = {
		input: invocation.input,
		...(runtime === undefined ? {} : { runtime }),
		startedAt: Date.now(),
		signal: cellSignal,
		onUpdate: invocation.onUpdate,
		toolCalls: [],
		toolCallMetrics: [],
		pendingBridgeCalls: [],
		statusEvents: [],
		active: true,
		output: "",
		phase: undefined,
		error: undefined,
		durationMs: 0,
		status: "pending",
	};
	let detached = false;
	let execution: CellExecution;
	const cell = cellManager.create(invocation.cellId, invocation.input, (error) => execution.cancel(error));
	execution = new CellExecution({
		callerSignal: invocation.signal,
		cellId: invocation.cellId,
		...(detaches
			? {
					idle: {
						timeoutMs: detachAfterMs,
						maxPauseGraceMs: foregroundWindowMs,
						onTimeout: (error: Error) => {
							if (cellManager.detach(cell)) {
								detached = true;
								execution.detach();
								return;
							}
							execution.cancel(error);
						},
					},
				}
			: {}),
		timeoutFactory: options.timeoutFactory ?? defaultTimeoutFactory,
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
	let settleEventEmitted = false;
	const emitSettled = (outcome: EvalExecutionSettleOutcome): void => {
		if (settleEventEmitted) return;
		settleEventEmitted = true;
		options.onCellSettled?.(
			buildEvalExecutionEventPayload({
				cellId: invocation.cellId,
				state,
				outcome,
				completedAt: Date.now(),
				detached,
			}),
		);
	};
	const finalized = running.then(
		(result) => {
			cellManager.complete(cell, result);
			emitSettled({ result });
			return result;
		},
		(error: unknown) => {
			cellManager.fail(cell, error instanceof Error ? error : new Error(String(error)));
			emitSettled({ error });
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
						cellManager.pause(cell);
						return;
					}
					if (message.event.op === TIMEOUT_RESUME_OP) {
						execution.resume();
						cellManager.resume(cell);
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
		cellManager.markRunning(
			cell,
			kernel,
			() => activeHandler.liveResult(),
			(error) => execution.cancel(error),
		);
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
