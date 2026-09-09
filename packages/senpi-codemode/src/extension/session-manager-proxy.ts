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

const defaultTeardownFailureReporter = (error: unknown): void => {
	globalThis.process.stderr.write(`[senpi-codemode] ${describeTeardownFailure(error)}\n`);
};

function describeTeardownFailure(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (error instanceof AggregateError && error.errors.length > 0) {
		const causes = error.errors.map((cause) => (cause instanceof Error ? cause.message : String(cause))).join("; ");
		return `session teardown failed: ${message} (${causes})`;
	}
	return `session teardown failed: ${message}`;
}

export class SessionManagerProxy implements CodemodeSessionManager, EvalExecutionTracker {
	#current: CodemodeSessionManager | undefined;
	#generation = 0;
	#started = false;
	#acceptingExecutions = false;
	readonly #executions = new Set<TrackedExecution>();
	readonly #onTeardownFailure: (error: unknown) => void;

	constructor(onTeardownFailure: (error: unknown) => void = defaultTeardownFailureReporter) {
		this.#onTeardownFailure = onTeardownFailure;
	}

	beginReplacement(): number {
		this.#generation++;
		this.#acceptingExecutions = false;
		this.#abortExecutions();
		return this.#generation;
	}

	async replace(generation: number, next: CodemodeSessionManager): Promise<boolean> {
		if (generation !== this.#generation) {
			await this.#disposeQuietly(next);
			return false;
		}
		await this.#settleExecutions();
		if (generation !== this.#generation) {
			await this.#disposeQuietly(next);
			return false;
		}
		const current = this.#current;
		this.#current = undefined;
		await this.#disposeQuietly(current);
		if (generation !== this.#generation) {
			await this.#disposeQuietly(next);
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
		await this.#disposeQuietly(current);
	}

	/**
	 * Session teardown is best-effort: a kernel or bridge that fails to confirm
	 * close (e.g. a SIGKILLed interpreter missing its reap window throws
	 * KernelRetirementError into the manager's dispose AggregateError) must not
	 * reject the session lifecycle handler that triggered the teardown — the
	 * extension host surfaces such rejections as user-facing extension errors.
	 */
	async #disposeQuietly(manager: CodemodeSessionManager | undefined): Promise<void> {
		if (manager === undefined) return;
		try {
			await manager.dispose();
		} catch (error) {
			this.#onTeardownFailure(error);
		}
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
