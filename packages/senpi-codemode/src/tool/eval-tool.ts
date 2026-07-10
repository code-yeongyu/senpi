import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext, ToolDefinition } from "@code-yeongyu/senpi";
import type { HostToKernelMessage, KernelToHostMessage } from "../bridge/protocol.ts";
import type { CompletionRequest, CompletionResult } from "../completion/handler.ts";
import { buildEvalPrompt } from "../prompt/eval-prompt.ts";
import { CellHandler, type CellState } from "./cell-handler.ts";
import { renderEvalCall, renderEvalResult } from "./render.ts";
import {
	createEvalInputSchema,
	type EnabledEvalLanguages,
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

type ToolReply = Extract<HostToKernelMessage, { type: "tool-reply" }>;

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
	#rejectAbort: (reason?: unknown) => void = () => {};
	#kernel: CellKernel | undefined;
	#deadline: ReturnType<typeof setTimeout> | undefined;
	#active = true;

	constructor(callerSignal: AbortSignal | undefined, timeoutMs: number, onAbort: (error: Error) => void) {
		this.#callerSignal = callerSignal;
		this.#onAbort = onAbort;
		this.#abortPromise = new Promise<never>((_resolve, reject) => {
			this.#rejectAbort = reject;
		});
		callerSignal?.addEventListener("abort", this.#handleCallerAbort, { once: true });
		this.#deadline = setTimeout(() => {
			const error = new Error(`Cell timed out after ${timeoutMs}ms`);
			error.name = "TimeoutError";
			this.#abort(error);
		}, timeoutMs);
	}

	setKernel(kernel: CellKernel): void {
		this.#kernel = kernel;
	}

	cancel(reason: unknown): void {
		this.#abort(reason);
	}

	async wait<T>(operation: Promise<T>): Promise<T> {
		return await Promise.race([operation, this.#abortPromise]);
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
		this.#rejectAbort(error);
		const kernel = this.#kernel;
		if (kernel)
			void Promise.resolve()
				.then(() => kernel.interrupt(error.message))
				.catch(() => undefined);
	}

	#cleanup(): void {
		this.#callerSignal?.removeEventListener("abort", this.#handleCallerAbort);
		if (this.#deadline !== undefined) {
			clearTimeout(this.#deadline);
			this.#deadline = undefined;
		}
	}
}

export function createEvalTool(
	options: CreateEvalToolOptions,
): ToolDefinition<ReturnType<typeof createEvalInputSchema>, EvalToolDetails> {
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
	const execution = new CellExecution(invocation.signal, timeoutMs, (error) => {
		state.active = false;
		bridgeAbortController.abort(error);
	});
	let handler: CellHandler | undefined;
	try {
		const acquired = await execution.wait(
			options.kernelManager.getKernel(invocation.input.language, (message) => {
				if (!state.active || !handler) return;
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
		const result = await execution.wait(
			kernel.run({ cellId: invocation.cellId, code: invocation.input.code, timeoutMs }),
		);
		if (result.ok) await execution.wait(Promise.all(state.pendingBridgeCalls));
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
