import { createHash } from "node:crypto";
import type { ExtensionContext } from "@code-yeongyu/senpi";
import type { createEvalTool } from "../tool/eval-tool.ts";
import { CodemodeSessionDisposedError } from "./session-manager.ts";
import { CodemodeSessionNotStartedError } from "./session-manager-proxy.ts";

export class CodemodeRuntimeRecreationError extends Error {
	readonly name = "CodemodeRuntimeRecreationError";

	constructor(reason: string) {
		super(`codemode runtime could not be re-created: ${reason}. Start a new session or reload to bring eval back.`);
	}
}

type StartSession = (event: unknown, ctx: ExtensionContext) => Promise<void>;

/**
 * A session_start whose runtime could not be created leaves the session running with no usable manager. The
 * next eval re-creates the runtime once for that failed start (concurrent evals share the attempt) and runs; a
 * failed re-creation is reported to every later eval until the next session_start. One stderr line names the
 * failed start with a hashed session id so a recurrence stays visible. A session that ended is never recovered.
 */
export class StartRecovery {
	readonly #startSession: StartSession;
	readonly #report: (line: string) => void;
	#failedStartEvent: { readonly event: unknown } | undefined;
	#recreation: Promise<void> | undefined;
	#recreationFailure: CodemodeRuntimeRecreationError | undefined;

	constructor(
		startSession: StartSession,
		report: (line: string) => void = (line) => globalThis.process.stderr.write(`${line}\n`),
	) {
		this.#startSession = startSession;
		this.#report = report;
	}

	async runStart(event: unknown, ctx: ExtensionContext): Promise<void> {
		try {
			await this.#startSession(event, ctx);
			this.#reset();
		} catch (error) {
			this.#reset();
			this.#failedStartEvent = { event };
			throw error;
		}
	}

	sessionEnded(): void {
		this.#reset();
	}

	wrapExecute<Args extends unknown[], Result>(
		execute: (...args: Args) => Promise<Result>,
		contextOf: (args: Args) => ExtensionContext,
	): (...args: Args) => Promise<Result> {
		return async (...args) => {
			try {
				return await execute(...args);
			} catch (error) {
				if (!(error instanceof CodemodeSessionDisposedError || error instanceof CodemodeSessionNotStartedError)) {
					throw error;
				}
				if (this.#recreationFailure !== undefined) throw this.#recreationFailure;
				const recreation = this.#recreation ?? this.#beginRecreation(contextOf(args));
				if (recreation === undefined) throw error;
				await recreation;
				return await execute(...args);
			}
		};
	}

	#beginRecreation(ctx: ExtensionContext): Promise<void> | undefined {
		const failed = this.#failedStartEvent;
		if (failed === undefined) return undefined;
		this.#report(
			`[senpi-codemode] eval re-created a runtime left disposed by a failed session_start (session ${sessionHash(ctx)})`,
		);
		const recreation = this.#startSession(failed.event, ctx).then(
			() => {
				this.#recreation = undefined;
				this.#reset();
			},
			(error: unknown) => {
				this.#recreation = undefined;
				this.#recreationFailure = new CodemodeRuntimeRecreationError(
					error instanceof Error ? error.message : String(error),
				);
				throw this.#recreationFailure;
			},
		);
		this.#recreation = recreation;
		return recreation;
	}

	#reset(): void {
		this.#failedStartEvent = undefined;
		this.#recreationFailure = undefined;
	}
}

export function withStartRecovery<Tool extends ReturnType<typeof createEvalTool>>(
	recovery: StartRecovery,
	tool: Tool,
): Tool {
	return { ...tool, execute: recovery.wrapExecute(tool.execute, (args) => args[4]) };
}

function sessionHash(ctx: ExtensionContext): string {
	return createHash("sha256").update(ctx.sessionManager.getSessionId()).digest("hex").slice(0, 12);
}
