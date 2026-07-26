import type { ExtensionContext } from "@code-yeongyu/senpi";
import type { KernelToHostMessage } from "../bridge/protocol.ts";
import type { CompletionRequest, CompletionResult } from "../completion/handler.ts";
import type { EvalKernel, EvalLanguage } from "../tool/types.ts";
import {
	CodemodeSessionDisposedError,
	type CodemodeSessionManager,
	type EvalExecutionTracker,
} from "./session-manager.ts";

type TrackedExecution = {
	readonly promise: Promise<unknown>;
	readonly controller: AbortController;
};

export class CodemodeSessionNotStartedError extends Error {
	readonly name = "CodemodeSessionNotStartedError";

	constructor() {
		super("codemode session has not started");
	}
}

export class SessionManagerProxy implements CodemodeSessionManager, EvalExecutionTracker {
	#current: CodemodeSessionManager | undefined;
	#generation = 0;
	#started = false;
	#acceptingExecutions = false;
	readonly #executions = new Set<TrackedExecution>();

	beginReplacement(): number {
		this.#generation++;
		this.#acceptingExecutions = false;
		this.#abortExecutions();
		return this.#generation;
	}

	async replace(generation: number, next: CodemodeSessionManager): Promise<boolean> {
		if (generation !== this.#generation) {
			await next.dispose();
			return false;
		}
		await this.#settleExecutions();
		if (generation !== this.#generation) {
			await next.dispose();
			return false;
		}
		const current = this.#current;
		this.#current = undefined;
		await current?.dispose();
		if (generation !== this.#generation) {
			await next.dispose();
			return false;
		}
		this.#current = next;
		this.#started = true;
		this.#acceptingExecutions = true;
		return true;
	}

	assertEvalExecutionAllowed(): void {
		if (this.#acceptingExecutions && this.#current !== undefined) return;
		if (this.#started) throw new CodemodeSessionDisposedError();
		throw new CodemodeSessionNotStartedError();
	}

	async trackEvalExecution<Result>(execution: Promise<Result>, controller: AbortController): Promise<Result> {
		this.assertEvalExecutionAllowed();
		const tracked: TrackedExecution = { promise: execution, controller };
		this.#executions.add(tracked);
		try {
			return await execution;
		} finally {
			this.#executions.delete(tracked);
		}
	}

	async getKernel(language: EvalLanguage, onMessage: (message: KernelToHostMessage) => void): Promise<EvalKernel> {
		this.assertEvalExecutionAllowed();
		const current = this.#current;
		if (current === undefined) throw new CodemodeSessionNotStartedError();
		return await current.getKernel(language, onMessage);
	}

	async complete(request: CompletionRequest, ctx: ExtensionContext): Promise<CompletionResult> {
		this.assertEvalExecutionAllowed();
		const current = this.#current;
		if (current === undefined) throw new CodemodeSessionNotStartedError();
		return await current.complete(request, ctx);
	}

	setContext(ctx: ExtensionContext): void {
		this.#current?.setContext?.(ctx);
	}

	async dispose(): Promise<void> {
		this.#generation++;
		this.#acceptingExecutions = false;
		this.#abortExecutions();
		await this.#settleExecutions();
		const current = this.#current;
		this.#current = undefined;
		await current?.dispose();
	}

	#abortExecutions(): void {
		if (this.#executions.size === 0) return;
		const error = new CodemodeSessionDisposedError();
		for (const execution of this.#executions) execution.controller.abort(error);
	}

	async #settleExecutions(): Promise<void> {
		if (this.#executions.size === 0) return;
		await Promise.allSettled([...this.#executions].map((execution) => execution.promise));
	}
}
