import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext, ToolDefinition } from "@code-yeongyu/senpi";
import type { CompletionRequest, CompletionResult } from "../completion/handler.ts";
import { defaultCodemodeSettings, type ResolvedCodemodeSettings } from "../config/settings.ts";
import type { EvalExecutionTracker } from "../extension/session-manager.ts";
import { buildEvalPrompt } from "../prompt/eval-prompt.ts";
import { TIMEOUT_PAUSE_OP, TIMEOUT_RESUME_OP } from "../timeouts/bridge-timeout.ts";
import { IdleTimeout } from "../timeouts/idle-timeout.ts";
import { CellHandler, type CellState } from "./cell-handler.ts";
import type { EvalImageResizer } from "./image.ts";
import {
	createEvalInputSchema,
	type EnabledEvalLanguages,
	type EvalInputSchema,
	type EvalKernel,
	type EvalKernelManager,
	type EvalToolDetails,
	type EvalToolInput,
	type ExecuteTool,
	enabledLanguageList,
} from "./types.ts";

export type { EnabledEvalLanguages, EvalKernel, EvalKernelManager } from "./types.ts";

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
	readonly proxyExecutor?: (params: EvalToolInput, signal?: AbortSignal) => Promise<AgentToolResult<EvalToolDetails>>;
	readonly renderers?: Pick<ToolDefinition<EvalInputSchema, EvalToolDetails>, "renderCall" | "renderResult">;
	/** Whether the task-tool spawn helpers (agent()/output()/<dag>) are advertised in the prompt. */
	readonly spawns?: boolean;
	/** Default agent name surfaced in the agent() helper docs when spawns are enabled. */
	readonly spawnDefaultAgent?: string;
	/** Active model id; selects the emphasis dialect of the eval prompt. */
	readonly modelId?: string;
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
	readonly onAbort: (error: Error) => void;
	readonly timeoutMs: number;
}

const INTERRUPT_DELIVERY_GRACE_MS = 100;

class CellExecution {
	readonly #callerSignal: AbortSignal;
	readonly #onAbort: (error: Error) => void;
	readonly #abortPromise: Promise<never>;
	readonly #watchdog: IdleTimeout;
	#rejectAbort: ((reason?: unknown) => void) | undefined;
	#kernel: EvalKernel | undefined;
	#interruptDeadline: ReturnType<typeof setTimeout> | undefined;
	#active = true;

	constructor(options: CellExecutionOptions) {
		this.#callerSignal = options.callerSignal;
		this.#onAbort = options.onAbort;
		this.#abortPromise = new Promise<never>((_resolve, reject) => {
			this.#rejectAbort = reject;
		});
		this.#watchdog = new IdleTimeout({
			cellId: options.cellId,
			timeoutMs: options.timeoutMs,
			onTimeout: ({ error }) => this.#abort(error),
		});
		this.#callerSignal.addEventListener("abort", this.#handleCallerAbort, { once: true });
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
			.then(() => kernel.interrupt(error.message))
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
	});
	const languages = enabledLanguageList(options.enabledLanguages);
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
			if (options.proxyExecutor) return await options.proxyExecutor(params, signal);
			if (!languages.includes(params.language))
				throw new RangeError(
					`Unsupported eval language "${params.language}". Enabled languages: ${languages.join(", ")}`,
				);
			options.executionTracker?.assertEvalExecutionAllowed();
			const lifecycleController = new AbortController();
			const combinedSignal = signal
				? AbortSignal.any([signal, lifecycleController.signal])
				: lifecycleController.signal;
			const execution = runEvalCell(options, {
				cellId: toolCallId,
				input: params,
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
	invocation: EvalCellInvocation,
): Promise<AgentToolResult<EvalToolDetails>> {
	if (invocation.signal.aborted) throw abortError(invocation.signal.reason);
	const timeoutMs = Math.floor((invocation.input.timeout ?? options.cellTimeoutSeconds) * 1_000);
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
	const execution = new CellExecution({
		callerSignal: invocation.signal,
		cellId: invocation.cellId,
		onAbort: (error) => {
			state.active = false;
			bridgeAbortController.abort(error);
		},
		timeoutMs,
	});
	let handler: CellHandler | undefined;
	try {
		const acquired = await execution.wait(
			options.kernelManager.getKernel(invocation.input.language, (message) => {
				if (!state.active || !handler) return;
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
		const kernel = acquired;
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
		if ("setContext" in options.kernelManager && typeof options.kernelManager.setContext === "function") {
			options.kernelManager.setContext(bridgeContext);
		}
		if (invocation.input.reset) await execution.wait(kernel.reset());
		const result = await execution.wait(kernel.run({ cellId: invocation.cellId, code: invocation.input.code }));
		if (result.ok && state.pendingBridgeCalls.length > 0) await execution.wait(Promise.all(state.pendingBridgeCalls));
		return await handler.finalize(result);
	} catch (error) {
		if (handler && error instanceof Error && error.name === "CodemodeSessionDisposedError") {
			return await handler.finalizeCancellation(error);
		}
		throw error;
	} finally {
		state.active = false;
		bridgeAbortController.abort();
		execution.finish();
		if (handler) await handler.flushOutput();
	}
}

function abortError(reason: unknown): Error {
	if (reason instanceof Error && reason.name !== "AbortError") return reason;
	const error = new Error(typeof reason === "string" ? reason : "Eval interrupted", { cause: reason });
	error.name = "AbortError";
	return error;
}
