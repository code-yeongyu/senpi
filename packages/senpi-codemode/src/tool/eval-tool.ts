import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext, ToolDefinition } from "@code-yeongyu/senpi";
import type { CompletionRequest, CompletionResult } from "../completion/handler.ts";
import { defaultCodemodeSettings, type ResolvedCodemodeSettings } from "../config/settings.ts";
import type { EvalExecutionTracker } from "../extension/session-manager.ts";
import { buildEvalPrompt } from "../prompt/eval-prompt.ts";
import { TIMEOUT_PAUSE_OP, TIMEOUT_RESUME_OP } from "../timeouts/bridge-timeout.ts";
import { IdleTimeout, type IdleTimeoutOptions, type TimeoutPauseHandle } from "../timeouts/idle-timeout.ts";
import { CellHandler, type CellState } from "./cell-handler.ts";
import { EvalDetachedCellManager, type EvalDetachedCellSnapshot } from "./detached-cell-manager.ts";
import type { EvalImageResizer } from "./image.ts";
import { describeTimeoutState, interruptionStateNote } from "./interrupt-note.ts";
import {
	createEvalInputSchema,
	type EnabledEvalLanguages,
	type EvalCellResult,
	type EvalControlInput,
	type EvalInputSchema,
	type EvalKernel,
	type EvalKernelManager,
	type EvalToolDetails,
	type EvalToolInput,
	type EvalToolRequest,
	type ExecuteTool,
	enabledLanguageList,
} from "./types.ts";

export type { EnabledEvalLanguages, EvalKernel, EvalKernelManager } from "./types.ts";

export interface EvalTimeoutFactory {
	create(options: IdleTimeoutOptions): TimeoutPauseHandle & { dispose(): void };
}

export interface CreateEvalToolOptions {
	readonly enabledLanguages: EnabledEvalLanguages;
	readonly kernelManager: EvalKernelManager;
	readonly cellTimeoutSeconds: number;
	readonly executeTool: ExecuteTool;
	readonly complete?: (request: CompletionRequest, ctx: ExtensionContext) => Promise<CompletionResult>;
	readonly settings?: ResolvedCodemodeSettings;
	readonly artifactsDir?: string;
	readonly imageResizer?: EvalImageResizer;
	readonly executionTracker?: EvalExecutionTracker;
	readonly cellManager?: EvalDetachedCellManager;
	readonly timeoutFactory?: EvalTimeoutFactory;
	readonly proxyExecutor?: (params: EvalToolInput, signal?: AbortSignal) => Promise<AgentToolResult<EvalToolDetails>>;
	readonly renderers?: Pick<ToolDefinition<EvalInputSchema, EvalToolDetails>, "renderCall" | "renderResult">;
	/** Whether the task-tool spawn helpers (agent()/output()/<dag>) are advertised in the prompt. */
	readonly spawns?: boolean;
	/** Default agent name surfaced in the agent() helper docs when spawns are enabled. */
	readonly spawnDefaultAgent?: string;
	/** Active model id; selects the emphasis dialect of the eval prompt. */
	readonly modelId?: string;
	/** Preformatted host line rendered into the prompt's host-sizing note. */
	readonly hostLine?: string;
}

interface EvalCellInvocation {
	readonly cellId: string;
	readonly input: EvalToolInput;
	readonly signal: AbortSignal;
	readonly onUpdate: AgentToolUpdateCallback<EvalToolDetails> | undefined;
	readonly ctx: ExtensionContext;
}

interface CellExecutionOptions {
	readonly callerSignal: AbortSignal;
	readonly cellId: string;
	readonly timeoutMs: number;
	readonly timeoutFactory: EvalTimeoutFactory;
	readonly onTimeout: (error: Error) => void;
	readonly onAbort: (error: Error) => void;
}

const INTERRUPT_DELIVERY_GRACE_MS = 100;
const NON_INTERACTIVE_MODES = new Set(["print", "json"]);

const defaultTimeoutFactory: EvalTimeoutFactory = {
	create(options): IdleTimeout {
		return new IdleTimeout(options);
	},
};

class CellExecution {
	readonly #callerSignal: AbortSignal;
	readonly #onAbort: (error: Error) => void;
	readonly #abortPromise: Promise<never>;
	readonly #detachedPromise: Promise<void>;
	readonly #watchdog: TimeoutPauseHandle & { dispose(): void };
	#rejectAbort: ((reason?: unknown) => void) | undefined;
	#resolveDetached: (() => void) | undefined;
	#kernel: EvalKernel | undefined;
	#interruptDeadline: ReturnType<typeof setTimeout> | undefined;
	#active = true;

	constructor(options: CellExecutionOptions) {
		this.#callerSignal = options.callerSignal;
		this.#onAbort = options.onAbort;
		this.#abortPromise = new Promise<never>((_resolve, reject) => {
			this.#rejectAbort = reject;
		});
		this.#detachedPromise = new Promise<void>((resolve) => {
			this.#resolveDetached = resolve;
		});
		this.#watchdog = options.timeoutFactory.create({
			cellId: options.cellId,
			timeoutMs: options.timeoutMs,
			onTimeout: ({ error }) => options.onTimeout(error),
		});
		this.#callerSignal.addEventListener("abort", this.#handleCallerAbort, { once: true });
	}

	get detached(): Promise<void> {
		return this.#detachedPromise;
	}

	pause(): void {
		this.#watchdog.pause();
	}

	resume(): void {
		this.#watchdog.resume();
	}

	setKernel(kernel: EvalKernel): void {
		this.#kernel = kernel;
	}

	detach(): void {
		if (!this.#active) return;
		this.#watchdog.dispose();
		this.#resolveDetached?.();
		this.#resolveDetached = undefined;
	}

	cancel(reason: unknown): void {
		this.#abort(reason);
	}

	finish(): void {
		this.#active = false;
		this.#cleanup();
	}

	async wait<Result>(operation: Promise<Result>): Promise<Result> {
		const guarded = operation.then(
			(value): Result | Promise<never> => (this.#active ? value : this.#abortPromise),
			(reason: unknown): Promise<never> => (this.#active ? Promise.reject(reason) : this.#abortPromise),
		);
		return await Promise.race([guarded, this.#abortPromise]);
	}

	readonly #handleCallerAbort = (): void => {
		this.#abort(this.#callerSignal.reason);
	};

	/** Outcome of the most recent interrupt, when a kernel was interrupted. */
	interruptStateRetained: Promise<boolean> | undefined;

	#abort(reason: unknown): void {
		if (!this.#active) return;
		this.#active = false;
		this.#cleanup();
		const error = abortError(reason);
		this.#onAbort(error);
		const kernel = this.#kernel;
		if (kernel === undefined) {
			this.#settleAbort(error);
			return;
		}
		this.#interruptDeadline = setTimeout(() => this.#settleAbort(error), INTERRUPT_DELIVERY_GRACE_MS);
		void Promise.resolve()
			.then(async () => {
				const handle = await kernel.interrupt(error.message);
				// Kernels predating the interrupt-outcome contract resolve void; leave
				// the outcome undefined so callers report an honest unknown state.
				this.interruptStateRetained = handle?.stateRetained;
			})
			.then(
				() => this.#settleAbort(error),
				(interruptError: unknown) => this.#settleAbort(interruptError),
			);
	}

	#settleAbort(reason: unknown): void {
		const reject = this.#rejectAbort;
		if (reject === undefined) return;
		this.#rejectAbort = undefined;
		if (this.#interruptDeadline !== undefined) clearTimeout(this.#interruptDeadline);
		reject(reason);
	}

	#cleanup(): void {
		this.#callerSignal.removeEventListener("abort", this.#handleCallerAbort);
		this.#watchdog.dispose();
		if (this.#interruptDeadline !== undefined) clearTimeout(this.#interruptDeadline);
		this.#interruptDeadline = undefined;
	}
}

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
			const request = requestFrom(params);
			if (isControlRequest(request)) return await executeControl(cellManager, request);
			if (options.proxyExecutor) return await options.proxyExecutor(request, signal);
			if (!languages.includes(request.language))
				throw new RangeError(
					`Unsupported eval language "${request.language}". Enabled languages: ${languages.join(", ")}`,
				);
			const busy = cellManager.busyFor(request.language);
			if (busy !== undefined) throw kernelBusyError(busy);
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
	const timeoutBehavior = timeoutBehaviorFor(invocation.input, invocation.ctx);
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
	if (outcome.kind === "detached") return detachedResult(cellManager.peek(invocation.cellId), invocation.input);
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
		handler = new CellHandler(kernel, state, {
			executeTool: options.executeTool,
			settings: options.settings ?? defaultCodemodeSettings,
			...(options.complete === undefined ? {} : { complete: options.complete }),
			ctx: bridgeContext,
			...(options.artifactsDir === undefined
				? {}
				: { artifactPath: join(options.artifactsDir, `eval-${randomUUID()}.log`) }),
			...(options.imageResizer === undefined ? {} : { imageResizer: options.imageResizer }),
		});
		cellManager.markRunning(cell, kernel, () => state.output);
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

function requestFrom(params: unknown): EvalToolRequest {
	if (typeof params !== "object" || params === null) throw new TypeError("eval parameters must be an object");
	const value = params as Record<string, unknown>;
	if (value.action === "peek" || value.action === "stop") {
		if (typeof value.cell_id !== "string" || value.cell_id.length === 0)
			throw new TypeError(`eval action "${value.action}" requires cell_id`);
		return { action: value.action, cell_id: value.cell_id };
	}
	if (value.action !== undefined && value.action !== "run")
		throw new TypeError(`Unknown eval action "${String(value.action)}"`);
	if (!isEvalLanguage(value.language)) throw new TypeError("eval run requires language");
	if (typeof value.code !== "string") throw new TypeError("eval run requires code");
	if (value.on_timeout !== undefined && value.on_timeout !== "detach" && value.on_timeout !== "error")
		throw new TypeError(`Unknown eval on_timeout value "${String(value.on_timeout)}"`);
	return {
		language: value.language,
		code: value.code,
		...(value.action === "run" ? { action: "run" as const } : {}),
		...(typeof value.title === "string" ? { title: value.title } : {}),
		...(typeof value.timeout === "number" ? { timeout: value.timeout } : {}),
		...(value.on_timeout === "detach" || value.on_timeout === "error" ? { on_timeout: value.on_timeout } : {}),
		...(typeof value.reset === "boolean" ? { reset: value.reset } : {}),
	};
}

function isControlRequest(request: EvalToolRequest): request is EvalControlInput {
	return request.action === "peek" || request.action === "stop";
}

function isEvalLanguage(value: unknown): value is EvalToolInput["language"] {
	return value === "py" || value === "js" || value === "rb" || value === "jl";
}

async function executeControl(
	cellManager: EvalDetachedCellManager,
	request: EvalControlInput,
): Promise<AgentToolResult<EvalToolDetails>> {
	const snapshot =
		request.action === "stop" ? await cellManager.stop(request.cell_id) : cellManager.peek(request.cell_id);
	return snapshotResult(snapshot);
}

function detachedResult(snapshot: EvalDetachedCellSnapshot, input: EvalToolInput): AgentToolResult<EvalToolDetails> {
	return {
		content: [
			{
				type: "text",
				text: `Eval cell ${snapshot.cellId} detached and is still running in the ${input.language} kernel. Completion will arrive as a notification. Use eval({ action: "peek", cell_id: "${snapshot.cellId}" }) or eval({ action: "stop", cell_id: "${snapshot.cellId}" }).`,
			},
		],
		details: {
			language: input.language,
			languages: [input.language],
			...(input.title === undefined ? {} : { title: input.title }),
			durationMs: 0,
			toolCalls: [],
			truncated: false,
			statusEvents: [{ op: "detached", cellId: snapshot.cellId }],
			cells: [
				{
					index: 0,
					...(input.title === undefined ? {} : { title: input.title }),
					code: input.code,
					language: input.language,
					output: snapshot.outputTail,
					status: "detached",
					statusEvents: [{ op: "detached", cellId: snapshot.cellId }],
				},
			],
		},
	};
}

function snapshotResult(snapshot: EvalDetachedCellSnapshot): AgentToolResult<EvalToolDetails> {
	const terminationNote =
		snapshot.state === "cancelled" ? interruptionStateNote(snapshot.language, snapshot.stateRetained) : undefined;
	const text = [
		`Eval cell ${snapshot.cellId} (${snapshot.language}) is ${snapshot.state}.`,
		snapshot.outputTail.length === 0 ? "(no buffered output)" : snapshot.outputTail,
		...(terminationNote === undefined ? [] : [terminationNote]),
	].join("\n");
	return {
		content: [{ type: "text", text }],
		details: {
			language: snapshot.language,
			languages: [snapshot.language],
			durationMs: snapshot.result?.details.durationMs ?? 0,
			toolCalls: snapshot.result?.details.toolCalls ?? [],
			truncated: snapshot.result?.details.truncated ?? false,
			...(snapshot.state === "failed" ? { isError: true } : {}),
			statusEvents: [{ op: snapshot.state, cellId: snapshot.cellId }],
			cells: [
				{
					index: 0,
					code: "",
					language: snapshot.language,
					output: snapshot.outputTail,
					status: cellStatus(snapshot.state),
					statusEvents: [{ op: snapshot.state, cellId: snapshot.cellId }],
				},
			],
		},
	};
}

function cellStatus(state: EvalDetachedCellSnapshot["state"]): EvalCellResult["status"] {
	switch (state) {
		case "running":
			return "running";
		case "detached":
			return "detached";
		case "completed":
			return "complete";
		case "failed":
			return "error";
		case "cancelled":
			return "cancelled";
	}
}

function kernelBusyError(snapshot: EvalDetachedCellSnapshot): Error {
	const tail = snapshot.outputTail.length === 0 ? "(no output yet)" : snapshot.outputTail;
	return new Error(
		`The ${snapshot.language} eval kernel is busy running detached cell ${snapshot.cellId}. Do not re-run it; use eval({ action: "peek", cell_id: "${snapshot.cellId}" }). Current output tail:\n${tail}`,
	);
}

function timeoutBehaviorFor(input: EvalToolInput, ctx: ExtensionContext): "detach" | "error" {
	if (input.on_timeout !== undefined) return input.on_timeout;
	return NON_INTERACTIVE_MODES.has(ctx.mode) ? "error" : "detach";
}

function abortError(reason: unknown): Error {
	if (reason instanceof Error && reason.name !== "AbortError") return reason;
	const error = new Error(typeof reason === "string" ? reason : "Eval interrupted", { cause: reason });
	error.name = "AbortError";
	return error;
}
