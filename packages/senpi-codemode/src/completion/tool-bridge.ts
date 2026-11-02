import type { ExtensionContext } from "@code-yeongyu/senpi";
import type { KernelToHostMessage } from "../bridge/protocol.ts";
import type { HandleRegistry } from "../handles/handle-registry.ts";
import type { EvalKernel } from "../tool/types.ts";
import { replyValue, startCompletionHandle, wantsCompletionHandle } from "./handle.ts";
import type { CompletionRequest, CompletionResult } from "./handler.ts";

export interface CompletionToolCallOptions {
	readonly message: Extract<KernelToHostMessage, { type: "tool-call" }>;
	readonly kernel: EvalKernel;
	readonly complete: (request: CompletionRequest, ctx: ExtensionContext) => Promise<CompletionResult>;
	readonly ctx: ExtensionContext;
	readonly isActive: () => boolean;
	/** Needed only for `completion(prompt, {handle: true})`; without it that option is refused. */
	readonly handles?: HandleRegistry;
	/** The creating cell's hard deadline (absolute ms) bounding a completion handle. */
	readonly hardDeadlineMs?: number;
}

export type CompletionToolCallSummary = { readonly ok: true } | { readonly ok: false; readonly error: string };

export async function handleCompletionToolCall(options: CompletionToolCallOptions): Promise<CompletionToolCallSummary> {
	try {
		const request = toCompletionRequest(options.message.args);
		const value = wantsCompletionHandle(request.opts)
			? startCompletionHandle({
					registry: requireRegistry(options.handles),
					request,
					complete: options.complete,
					ctx: options.ctx,
					deadlineMs: options.hardDeadlineMs ?? Number.POSITIVE_INFINITY,
				})
			: replyValue(await options.complete(request, options.ctx));
		if (!options.isActive()) return { ok: false, error: "completion() result ignored after eval finalization" };
		options.kernel.deliverToolReply({ type: "tool-reply", callId: options.message.callId, ok: true, value });
		return { ok: true };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!options.isActive()) return { ok: false, error: message };
		options.kernel.deliverToolReply({
			type: "tool-reply",
			callId: options.message.callId,
			ok: false,
			error: {
				message,
				...(error instanceof Error && "code" in error && typeof error.code === "string"
					? { code: error.code }
					: {}),
			},
		});
		return { ok: false, error: message };
	}
}

function requireRegistry(handles: HandleRegistry | undefined): HandleRegistry {
	if (handles !== undefined) return handles;
	throw Object.assign(
		new Error("eval_wait_unavailable: completion handles are not available before the session starts"),
		{ code: "eval_wait_unavailable" },
	);
}

function toCompletionRequest(value: unknown): CompletionRequest {
	if (typeof value === "object" && value !== null && "prompt" in value && typeof value.prompt === "string") {
		return {
			prompt: value.prompt,
			opts: "opts" in value ? value.opts : undefined,
			model: "model" in value && typeof value.model === "string" ? value.model : undefined,
			system: "system" in value && typeof value.system === "string" ? value.system : undefined,
			schema: "schema" in value ? value.schema : undefined,
		};
	}
	throw new Error("completion() received invalid arguments");
}
