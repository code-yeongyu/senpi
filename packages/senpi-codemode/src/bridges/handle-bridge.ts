import { EvalHandleError, type EvalHandleHost } from "@code-yeongyu/senpi";
import {
	RESERVED_HANDLE_CANCEL_TOOL,
	RESERVED_HANDLE_OUTPUT_TOOL,
	RESERVED_HANDLE_SEND_TOOL,
	RESERVED_HANDLE_STATUS_TOOL,
	RESERVED_WAIT_TOOL,
} from "../bridge/reserved.ts";
import { parseOutputArgs, parseRefArgs, parseSendArgs, parseWaitArgs } from "../handles/handle-args.ts";
import type { HandleBackend, HandleRegistry } from "../handles/handle-registry.ts";
import { waitForHandles } from "../handles/wait.ts";

export const HANDLE_TOOL_NAMES = [
	RESERVED_WAIT_TOOL,
	RESERVED_HANDLE_STATUS_TOOL,
	RESERVED_HANDLE_OUTPUT_TOOL,
	RESERVED_HANDLE_SEND_TOOL,
	RESERVED_HANDLE_CANCEL_TOOL,
] as const;

export type HandleToolName = (typeof HANDLE_TOOL_NAMES)[number];

export interface HandleBridgeContext {
	/** The session generation's registry; absent only for the pre-session baseline tool. */
	readonly registry: HandleRegistry | undefined;
	/** `ctx.evalHandleHost` at dispatch time; absent on a runtime without a provider. */
	readonly host: EvalHandleHost | undefined;
	/** The calling cell's signal: cancelling the cell closes its subscriptions immediately. */
	readonly signal: AbortSignal | undefined;
}

export function isHandleToolName(toolName: string): toolName is HandleToolName {
	return HANDLE_TOOL_NAMES.some((name) => name === toolName);
}

/** Dispatches the five reserved handle tools; every path is fenced by the registry before any host call. */
export async function runHandleTool(toolName: HandleToolName, args: unknown, context: HandleBridgeContext) {
	const registry = context.registry;
	if (registry === undefined) {
		throw new EvalHandleError(
			"eval_wait_unavailable",
			"wait()/handle() are not supported by this runtime: this session has no handle registry yet",
		);
	}
	const backend: HandleBackend = { host: context.host, signal: context.signal };
	switch (toolName) {
		case RESERVED_WAIT_TOOL:
			return await waitForHandles(parseWaitArgs(args), {
				watch: (refs) => registry.watch(refs, backend),
				result: (ref) => registry.result(ref, backend),
				...(context.signal === undefined ? {} : { signal: context.signal }),
			});
		case RESERVED_HANDLE_STATUS_TOOL:
			return await registry.status(parseRefArgs(args, "control.status()"), backend);
		case RESERVED_HANDLE_OUTPUT_TOOL: {
			const { ref, request } = parseOutputArgs(args);
			return await registry.output(ref, request, backend);
		}
		case RESERVED_HANDLE_SEND_TOOL: {
			const { ref, message } = parseSendArgs(args);
			return await registry.send(ref, message, backend);
		}
		case RESERVED_HANDLE_CANCEL_TOOL:
			return await registry.cancel(parseRefArgs(args, "control.cancel()"), backend);
		default:
			return assertNever(toolName);
	}
}

function assertNever(value: never): never {
	throw new TypeError(`Unsupported handle tool: ${String(value)}`);
}
