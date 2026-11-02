import type { ExtensionContext } from "@code-yeongyu/senpi";
import type { BridgeHttpCompletionRequest } from "../bridge/http-server.ts";
import { startCompletionHandle, wantsCompletionHandle } from "../completion/handle.ts";
import type { CompletionRequest } from "../completion/handler.ts";
import { resolveHardLimitSeconds } from "../config/settings.ts";
import type { CreateCodemodeSessionManagerOptions } from "./session-manager-contract.ts";

export interface BridgeDispatchContext {
	/** The context of the cell that last reached the manager; the handle host and completion owner are read from it. */
	readonly context: ExtensionContext | undefined;
	readonly contextFor: (signal: AbortSignal) => ExtensionContext;
	readonly requireContext: () => ExtensionContext;
}

/**
 * `completion(prompt, handle=True)` from a subprocess kernel: the handle lives in the session registry and is
 * bounded by the hard limit measured from this request, the tightest bound the bridge knows for its cell.
 */
export async function dispatchBridgeCompletion(
	options: CreateCodemodeSessionManagerOptions,
	request: BridgeHttpCompletionRequest,
	dispatch: BridgeDispatchContext,
): Promise<unknown> {
	const completion: CompletionRequest = { prompt: request.prompt, opts: request.opts };
	if (!wantsCompletionHandle(request.opts)) {
		return await options.complete(completion, dispatch.contextFor(request.signal));
	}
	const registry = options.handles;
	if (registry === undefined) {
		throw Object.assign(new Error("eval_wait_unavailable: completion handles are not available in this session"), {
			code: "eval_wait_unavailable",
		});
	}
	return startCompletionHandle({
		registry,
		request: completion,
		complete: options.complete,
		ctx: dispatch.requireContext(),
		deadlineMs: Date.now() + resolveHardLimitSeconds(options.settings) * 1_000,
	});
}
