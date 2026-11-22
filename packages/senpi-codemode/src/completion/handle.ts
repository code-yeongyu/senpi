import type { ExtensionContext, HandleRef } from "@code-yeongyu/senpi";
import type { HandleRegistry } from "../handles/handle-registry.ts";
import type { CompletionRequest, CompletionResult } from "./handler.ts";

/** What `completion(prompt, {handle: true})` returns: a saved reference every prelude turns into a control view. */
export interface CompletionHandleRecord {
	readonly kind: "completion";
	readonly id: string;
	readonly run_epoch: number;
	readonly handle: string;
}

export interface StartCompletionHandleOptions {
	readonly registry: HandleRegistry;
	readonly request: CompletionRequest;
	readonly complete: (request: CompletionRequest, ctx: ExtensionContext) => Promise<CompletionResult>;
	readonly ctx: ExtensionContext;
	/** The creating cell's hard deadline (absolute ms); the completion is aborted at it. */
	readonly deadlineMs: number;
}

const COMPLETION_TIERS: ReadonlySet<string> = new Set(["smol", "default", "slow"]);

class CompletionHandleArgumentsError extends Error {
	readonly name = "CompletionHandleArgumentsError";
	readonly code = "eval_handle_invalid_arguments";

	constructor(detail: string) {
		super(`eval_handle_invalid_arguments: completion(prompt, {handle: true}) ${detail}`);
	}
}

/** True when the completion call opted into a handle (`{handle: true}` in its options). */
export function wantsCompletionHandle(opts: unknown): boolean {
	return typeof opts === "object" && opts !== null && "handle" in opts && opts.handle === true;
}

/**
 * Preflight-validates the request, then starts the completion in the session registry and returns its
 * reference at once. Provider failures surface in the handle's outcome, never here.
 */
export function startCompletionHandle(options: StartCompletionHandleOptions): CompletionHandleRecord {
	const request = withoutHandleOption(options.request);
	if (request.prompt.trim().length === 0) throw new CompletionHandleArgumentsError("needs a non-empty prompt");
	const tier = request.model ?? tierFromOpts(request.opts);
	if (tier !== undefined && !COMPLETION_TIERS.has(tier)) {
		throw new CompletionHandleArgumentsError(`got model tier "${tier}"; expected "smol", "default", or "slow"`);
	}
	const ref: HandleRef = options.registry.startCompletion({
		deadlineMs: options.deadlineMs,
		run: async (signal) => replyValue(await options.complete(request, { ...options.ctx, signal })),
	});
	return { kind: "completion", id: ref.id, run_epoch: ref.run_epoch, handle: `completion://${ref.id}` };
}

export function replyValue(result: CompletionResult): unknown {
	return "value" in result ? result.value : result.text;
}

function tierFromOpts(opts: unknown): string | undefined {
	if (typeof opts !== "object" || opts === null || !("model" in opts)) return undefined;
	return typeof opts.model === "string" ? opts.model : undefined;
}

function withoutHandleOption(request: CompletionRequest): CompletionRequest {
	if (typeof request.opts !== "object" || request.opts === null || !("handle" in request.opts)) return request;
	const { handle: _handle, ...opts } = request.opts;
	return { ...request, opts };
}
