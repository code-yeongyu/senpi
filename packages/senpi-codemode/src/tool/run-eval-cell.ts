import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
	type AgentToolResult,
	type ExtensionContext,
	type ExtensionKernelTools,
	kernelToolsStorage,
} from "@code-yeongyu/senpi";
import type { KernelToHostMessage } from "../bridge/protocol.ts";
import { DEFAULT_FOREGROUND_WINDOW_SECONDS, defaultCodemodeSettings } from "../config/settings.ts";
import {
	KERNEL_TOOLS_CAPABILITIES,
	type KernelToolsCapability,
	type KernelToolsDescribeResult,
} from "../kernels/js/kernel-tools-types.ts";
import { TIMEOUT_PAUSE_OP, TIMEOUT_RESUME_OP } from "../timeouts/bridge-timeout.ts";
import { abortError, CellExecution, defaultTimeoutFactory } from "./cell-execution.ts";
import { CellHandler, type CellState } from "./cell-handler.ts";
import type { EvalDetachedCellManager } from "./detached-cell-manager.ts";
import { EvalBackgroundCapacityError, resultAfterDetach, resultForDetachedState } from "./detached-eval-result.ts";
import { buildEvalExecutionEventPayload, type EvalExecutionSettleOutcome } from "./eval-execution-event.ts";
import { EvalKernelResetRefusedError } from "./eval-kernel-reset-refused-error.ts";
import { evalTimeoutBehavior } from "./eval-request.ts";
import type { CreateEvalToolOptions, EvalCellInvocation } from "./eval-tool-options.ts";
import { describeTimeoutState } from "./interrupt-note.ts";
import { loadCell } from "./load-cell.ts";
import { planMagicCell } from "./magic-cell-host.ts";
import type { EvalKernel, EvalToolDetails } from "./types.ts";

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
		status: "queued",
	};
	let detached = false;
	let execution: CellExecution;
	const cell = cellManager.create(invocation.cellId, invocation.input, (error) => execution.cancel(error));
	const detach = (): boolean => {
		if (!cellManager.detach(cell)) return false;
		detached = true;
		execution.detach();
		return true;
	};
	const cancelAtCapacity = (idleError: Error): void => {
		const liveCells = cellManager.liveCells(undefined, { except: invocation.cellId });
		if (
			!cell.canDetach &&
			liveCells.filter((live) => live.state === "detached").length < cellManager.maxDetachedCells
		) {
			execution.cancel(idleError);
			return;
		}
		execution.cancel(
			new EvalBackgroundCapacityError(
				cellManager.maxDetachedCells,
				invocation.cellId,
				Date.now() - state.startedAt,
				liveCells.map((live) => live.cellId),
			),
		);
	};
	execution = new CellExecution({
		callerSignal: invocation.signal,
		cellId: invocation.cellId,
		...(detaches
			? {
					idle: {
						timeoutMs: detachAfterMs,
						maxPauseGraceMs: foregroundWindowMs,
						onTimeout: (error: Error) => {
							if (detach()) return;
							const remainingMs = foregroundWindowMs - (Date.now() - state.startedAt);
							if (remainingMs <= 0) cancelAtCapacity(error);
							else
								execution.rearmIdle(remainingMs, () => {
									if (!detach()) cancelAtCapacity(error);
								});
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
	const steeringSignal =
		detaches && invocation.ctx.mode !== "print" && invocation.ctx.mode !== "json"
			? invocation.ctx.steeringSignal
			: undefined;
	const onSteering = (): void => {
		if (!steeringSignal?.aborted || detached || !state.active || invocation.signal.aborted) return;
		// Losing the slot keeps this call foreground; only the existing deadlines/caller may cancel it.
		detach();
	};
	steeringSignal?.addEventListener("abort", onSteering, { once: true });
	const running = executeCell(
		options,
		invocation,
		cellManager,
		cell,
		state,
		execution,
		bridgeContext,
		bridgeAbortController,
		onSteering,
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
				queuedMs: Math.max(0, (cell.runStartedAtMs ?? Date.now()) - cell.startedAtMs),
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
	try {
		const outcome = await Promise.race([
			finalized.then((result) => ({ kind: "result" as const, result })),
			execution.detached.then(() => ({ kind: "detached" as const })),
		]);
		if (outcome.kind === "detached")
			return resultAfterDetach(
				cellManager.peek(invocation.cellId),
				invocation.input,
				cellManager.liveCells(undefined, { except: invocation.cellId }).length,
			);
		return outcome.result;
	} finally {
		steeringSignal?.removeEventListener("abort", onSteering);
	}
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
	onReady: () => void,
): Promise<AgentToolResult<EvalToolDetails>> {
	let handler: CellHandler | undefined;
	const onMessage = (message: KernelToHostMessage): void => {
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
	};
	let releaseCellKernelTools: (() => void) | undefined;
	try {
		const kernel = await execution.wait(options.kernelManager.getKernel(invocation.input.language, onMessage));
		// Computed before the handler so its construction-time snapshot captures this cell's capability.
		// Worker messages later restore that snapshot before calling host tools (#1754, #2512).
		const kernelTools = kernelToolsFor(kernel);
		// Subprocess kernels call the host over the bridge, outside this async context. Their calls carry a fresh secret
		// minted for this run and sent only to this cell's kernel, never the model-visible cell id, so code in another
		// kernel cannot name this cell into its tools. JS calls already run inside this cell's scope (#1754).
		const bridgeCellToken =
			kernelTools === undefined || invocation.input.language === "js" ? undefined : randomUUID();
		releaseCellKernelTools =
			kernelTools === undefined || bridgeCellToken === undefined
				? undefined
				: options.kernelManager.bindCellKernelTools?.(bridgeCellToken, kernelTools);
		const runBound = async (): Promise<AgentToolResult<EvalToolDetails>> => {
			const queue = kernel.queueSnapshot();
			state.queuedBehind = [...(queue.activeCellId === null ? [] : [queue.activeCellId]), ...queue.queuedCellIds];
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
				...(kernelTools === undefined ? {} : { kernelTools }),
				...(options.handles === undefined ? {} : { handles: options.handles }),
				hardDeadlineMs: cell.startedAtMs + cell.hardLimitSeconds * 1_000,
			});
			handler = activeHandler;
			cellManager.bindKernel(
				cell,
				kernel,
				() => activeHandler.liveResult(),
				(error) => execution.cancel(error),
			);
			if (invocation.input.reset) {
				const liveCells = cellManager.liveCells(invocation.input.language, { except: invocation.cellId });
				if (liveCells.length > 0)
					throw new EvalKernelResetRefusedError(
						invocation.input.language,
						liveCells.map((live) => live.cellId),
					);
			}
			// Includes a steer already queued at execute start or received while acquiring the kernel.
			onReady();
			if ("setContext" in options.kernelManager && typeof options.kernelManager.setContext === "function") {
				options.kernelManager.setContext(bridgeContext);
			}
			if (invocation.input.reset) await execution.wait(kernel.reset());
			execution.setKernel(kernel);
			const magic = planMagicCell(invocation.input.language, invocation.input.code, options.pythonEnvironments);
			// Resolved when the cell's turn comes in the kernel's queue: a %load reads the file the cells ahead of it
			// wrote, and a refusal settles in queue order like any cell.
			const loadOptions = { cwd: invocation.ctx.cwd, artifactsDir: options.artifactsDir };
			const resolveAtStart =
				magic.kind === "load"
					? () => loadCell(magic.target, loadOptions)
					: magic.kind === "refused"
						? () => ({ ok: false as const, message: magic.message })
						: undefined;
			const environments = invocation.input.language === "py" ? options.pythonEnvironments : undefined;
			const envRoot = environments === undefined ? undefined : () => environments.activeRoot ?? "";
			const result = await execution.wait(
				kernel.run({
					cellId: invocation.cellId,
					code: invocation.input.code,
					...(resolveAtStart === undefined ? {} : { resolveAtStart }),
					...(magic.kind === "host" ? { host: magic.executor } : {}),
					...(envRoot === undefined ? {} : { envRoot }),
					...(bridgeCellToken === undefined ? {} : { bridgeCellToken }),
					kernelPreludes: options.kernelPreludes?.(),
					onMessage,
					onStarted: () => {
						cellManager.markRunning(cell);
						state.runStartedAt = cell.runStartedAtMs;
						state.status = "running";
						state.queuedBehind = undefined;
						state.onUpdate?.(activeHandler.liveResult());
					},
				}),
			);
			if (result.ok && state.pendingBridgeCalls.length > 0)
				await execution.wait(Promise.all(state.pendingBridgeCalls));
			return await handler.finalize(result);
		};
		return kernelTools ? await kernelToolsStorage.run(kernelTools, runBound) : await runBound();
	} catch (error) {
		if (error instanceof EvalBackgroundCapacityError) {
			const final = handler
				? await handler.finalizeCancellation(error)
				: {
						content: [{ type: "text" as const, text: error.message }],
						details: cellManager.peek(invocation.cellId).result.details,
					};
			const result = resultForDetachedState(final, "cancelled", state.durationMs);
			return { ...result, details: { ...result.details, isError: true, code: error.code } };
		}
		if (handler && error instanceof Error && error.name === "CodemodeSessionDisposedError")
			return await handler.finalizeCancellation(error);
		if (error instanceof Error && error.name === "TimeoutError") throw await describeTimeoutState(error, execution);
		throw error;
	} finally {
		// First, so nothing below can skip it: from here on a host call carrying this run's secret gets no kernel tools.
		releaseCellKernelTools?.();
		state.active = false;
		bridgeAbortController.abort();
		execution.finish();
		if (handler) await handler.flushOutput();
		// The cell settled: stop the kernel dispatcher from holding this cell's listener (#2260).
		options.kernelManager.releaseKernelListener?.(invocation.input.language, onMessage);
	}
}

function kernelToolsFor(kernel: EvalKernel): KernelToolsCapability | undefined {
	if (!("describeKernelTools" in kernel) || typeof kernel.describeKernelTools !== "function") return undefined;
	const withTools = kernel as EvalKernel & {
		describeKernelTools: (names: readonly string[]) => Promise<KernelToolsDescribeResult>;
		invokeKernelTool: ExtensionKernelTools["invoke"];
	};
	return {
		capabilities: KERNEL_TOOLS_CAPABILITIES,
		describe: (names) => withTools.describeKernelTools(names),
		invoke: (request, options) => withTools.invokeKernelTool(request, options),
	} satisfies ExtensionKernelTools;
}
