import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext, ToolDefinition } from "@code-yeongyu/senpi";
import type { HostToKernelMessage, KernelToHostMessage } from "../bridge/protocol.ts";
import type { CompletionRequest, CompletionResult } from "../completion/handler.ts";
import { buildEvalPrompt } from "../prompt/eval-prompt.ts";
import { TIMEOUT_PAUSE_OP, TIMEOUT_RESUME_OP } from "../timeouts/bridge-timeout.ts";
import { IdleTimeout } from "../timeouts/idle-timeout.ts";
import { CellHandler, type CellState } from "./cell-handler.ts";
import { renderEvalCall, renderEvalResult } from "./render.ts";
import {
	createEvalInputSchema,
	type EnabledEvalLanguages,
	type EvalInputSchema,
	type EvalKernel,
	type EvalKernelManager,
	type EvalKernelRunInput,
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
}

interface EvalCellInvocation {
	readonly cellId: string;
	readonly input: EvalToolInput;
	readonly signal: AbortSignal | undefined;
	readonly onUpdate: AgentToolUpdateCallback<EvalToolDetails> | undefined;
	readonly ctx: ExtensionContext;
}

interface CellExecutionOptions {
	readonly callerSignal: AbortSignal | undefined;
	readonly cellId: string;
	readonly onAbort: (error: Error) => void;
	readonly timeoutMs: number;
}

type ToolReply = Extract<HostToKernelMessage, { type: "tool-reply" }>;

const INTERRUPT_DELIVERY_GRACE_MS = 100;

class CellKernel implements EvalKernel {
	readonly #kernel: EvalKernel;
	readonly #state: CellState;

	constructor(kernel: EvalKernel, state: CellState) {
		this.#kernel = kernel;
		this.#state = state;
	}

	run(input: EvalKernelRunInput): Promise<Extract<KernelToHostMessage, { type: "result" }>> {
		return this.#kernel.run(input);
	}

	deliverToolReply(message: ToolReply): void {
		if (this.#state.active) this.#kernel.deliverToolReply(message);
	}

	interrupt(reason?: string): Promise<void> {
		return this.#kernel.interrupt(reason);
	}

	reset(): Promise<void> {
		return this.#kernel.reset();
	}

	close(): Promise<void> {
		return this.#kernel.close();
	}
}

class CellExecution {
	readonly #callerSignal: AbortSignal | undefined;
	readonly #onAbort: (error: Error) => void;
	readonly #abortPromise: Promise<never>;
	readonly #watchdog: IdleTimeout;
	#rejectAbort: (reason?: unknown) => void = () => {};
	#kernel: CellKernel | undefined;
	#interruptDeadline: ReturnType<typeof setTimeout> | undefined;
	#abortSettled = false;
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
		this.#callerSignal?.addEventListener("abort", this.#handleCallerAbort, { once: true });
	}

	pause(): void {
		this.#watchdog.pause();
	}

	resume(): void {
		this.#watchdog.resume();
	}

	setKernel(kernel: CellKernel): void {
		this.#kernel = kernel;
	}

	cancel(reason: unknown): void {
		this.#abort(reason);
	}

	async wait<T>(operation: Promise<T>): Promise<T> {
		const guardedOperation = operation.then(
			(value): T | Promise<never> => (this.#active ? value : this.#abortPromise),
			(reason: unknown): Promise<never> => (this.#active ? Promise.reject(reason) : this.#abortPromise),
		);
		return await Promise.race([guardedOperation, this.#abortPromise]);
	}

	finish(): void {
		this.#active = false;
		this.#cleanup();
	}

	readonly #handleCallerAbort = (): void => {
		this.#abort(this.#callerSignal?.reason);
	};

	#abort(reason: unknown): void {
		if (!this.#active) return;
		this.#active = false;
		this.#cleanup();
		const error = abortError(reason);
		this.#onAbort(error);
		const kernel = this.#kernel;
		if (!kernel) {
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
		if (this.#abortSettled) return;
		this.#abortSettled = true;
		this.#clearInterruptDeadline();
		this.#rejectAbort(reason);
	}

	#cleanup(): void {
		this.#callerSignal?.removeEventListener("abort", this.#handleCallerAbort);
		this.#watchdog.dispose();
		this.#clearInterruptDeadline();
	}

	#clearInterruptDeadline(): void {
		if (this.#interruptDeadline === undefined) return;
		clearTimeout(this.#interruptDeadline);
		this.#interruptDeadline = undefined;
	}
}

export function createEvalTool(options: CreateEvalToolOptions): ToolDefinition<EvalInputSchema, EvalToolDetails> {
	const parameters = createEvalInputSchema(options.enabledLanguages);
	const prompt = buildEvalPrompt(options.enabledLanguages);
	const languages = enabledLanguageList(options.enabledLanguages);
	return {
		name: "eval",
		label: "Eval",
		description: prompt.description,
		promptSnippet: prompt.promptSnippet,
		promptGuidelines: [...prompt.promptGuidelines],
		parameters,
		executionMode: "sequential",
		renderCall: renderEvalCall,
		renderResult: renderEvalResult,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (!languages.includes(params.language)) {
				throw new Error(
					`Unsupported eval language "${params.language}". Enabled languages: ${languages.join(", ")}`,
				);
			}
			return await runEvalCell(options, { cellId: toolCallId, input: params, signal, onUpdate, ctx });
		},
	};
}

async function runEvalCell(
	options: CreateEvalToolOptions,
	invocation: EvalCellInvocation,
): Promise<AgentToolResult<EvalToolDetails>> {
	if (invocation.signal?.aborted) throw abortError(invocation.signal.reason);
	const timeoutMs = Math.floor((invocation.input.timeout ?? options.cellTimeoutSeconds) * 1000);
	const bridgeAbortController = new AbortController();
	const cellSignal = invocation.signal
		? AbortSignal.any([invocation.signal, bridgeAbortController.signal])
		: bridgeAbortController.signal;
	const bridgeContext: ExtensionContext = { ...invocation.ctx, signal: cellSignal };
	const state: CellState = {
		cellId: invocation.cellId,
		language: invocation.input.language,
		title: invocation.input.title,
		signal: cellSignal,
		onUpdate: invocation.onUpdate,
		toolCalls: [],
		images: [],
		pendingBridgeCalls: [],
		active: true,
		output: "",
		phase: undefined,
		durationMs: 0,
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
		const kernel = new CellKernel(acquired, state);
		execution.setKernel(kernel);
		handler = new CellHandler(kernel, state, {
			executeTool: options.executeTool,
			complete: options.complete,
			ctx: bridgeContext,
		});
		if ("setContext" in options.kernelManager && typeof options.kernelManager.setContext === "function") {
			options.kernelManager.setContext(bridgeContext);
		}
		if (invocation.input.reset) await execution.wait(kernel.reset());
		const result = await execution.wait(kernel.run({ cellId: invocation.cellId, code: invocation.input.code }));
		if (result.ok && state.pendingBridgeCalls.length > 0) await execution.wait(Promise.all(state.pendingBridgeCalls));
		return handler.finalize(result);
	} finally {
		state.active = false;
		bridgeAbortController.abort();
		execution.finish();
	}
}

function abortError(reason: unknown): Error {
	if (reason instanceof Error && reason.name !== "AbortError") return reason;
	const error = new Error(typeof reason === "string" ? reason : "Eval interrupted");
	error.name = "AbortError";
	return error;
}
