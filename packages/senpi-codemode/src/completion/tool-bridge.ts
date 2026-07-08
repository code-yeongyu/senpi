import type { ExtensionContext } from "@code-yeongyu/senpi";
import type { KernelToHostMessage } from "../bridge/protocol.ts";
import type { EvalKernel } from "../tool/types.ts";
import type { CompletionRequest, CompletionResult } from "./handler.ts";

export interface CompletionToolCallOptions {
	readonly message: Extract<KernelToHostMessage, { type: "tool-call" }>;
	readonly kernel: EvalKernel;
	readonly complete: (request: CompletionRequest, ctx: ExtensionContext) => Promise<CompletionResult>;
	readonly ctx: ExtensionContext;
}

export type CompletionToolCallSummary = { readonly ok: true } | { readonly ok: false; readonly error: string };

export async function handleCompletionToolCall(options: CompletionToolCallOptions): Promise<CompletionToolCallSummary> {
	try {
		const value = await options.complete(toCompletionRequest(options.message.args), options.ctx);
		options.kernel.deliverToolReply({ type: "tool-reply", callId: options.message.callId, ok: true, value });
		return { ok: true };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		options.kernel.deliverToolReply({
			type: "tool-reply",
			callId: options.message.callId,
			ok: false,
			error: { message },
		});
		return { ok: false, error: message };
	}
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
