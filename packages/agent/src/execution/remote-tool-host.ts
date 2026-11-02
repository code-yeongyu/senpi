import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { Transport, TransportFrame } from "../transport/transport.ts";
import type { AgentToolCall } from "../types.ts";
import {
	decodeRemoteMessage,
	encodeRemoteMessage,
	type RemoteHandMessage,
	type RemoteInvoke,
	type RemoteToolResult,
} from "./remote-protocol.ts";
import type { ToolHost, ToolHostCall, ToolHostOptions, ToolHostResult } from "./tool-host.ts";

export interface RemoteToolHostOptions {
	/** The session's end of the link to the hand; lanes are execution scope IDs. */
	readonly transport: Transport;
	/** What the session says about itself; the hand never acts on it (R16). */
	readonly sessionRef?: string;
	readonly mintId?: () => string;
}

interface Pending {
	readonly resolve: (result: RemoteToolResult) => void;
}

function errorResult(text: string): RemoteToolResult {
	return { content: [{ type: "text", text }], details: {}, isError: true };
}

/**
 * The ToolHost that runs a session's tool calls on a hand (brain/hand split, S27a). The hand resolves, prepares,
 * validates, runs the extensions' `tool_call`/`tool_result` handlers (permission checks among them) and executes each
 * call; this host keeps the loop's side: tool events, the batch's ordering, a forwarded abort and the result messages in
 * source order. Every call is dispatched once and never re-sent: a link that fails before a settle becomes an error
 * result for that call, never a retry.
 */
export function createRemoteToolHost(options: RemoteToolHostOptions): ToolHost & { close(): void } {
	const { transport } = options;
	const mintId = options.mintId ?? (() => crypto.randomUUID());
	const pending = new Map<string, Pending>();

	const settle = (executionId: string, result: RemoteToolResult): void => {
		const waiter = pending.get(executionId);
		if (waiter === undefined) return;
		pending.delete(executionId);
		waiter.resolve(result);
	};

	transport.onFrame((frame: TransportFrame) => {
		let message: RemoteHandMessage;
		try {
			message = decodeRemoteMessage(frame.payload);
		} catch {
			return;
		}
		if (message.kind === "settled") settle(message.executionId, message.result);
		else if (message.kind === "refused")
			settle(message.executionId, errorResult(`The hand refused this tool call: ${message.reason}`));
	});

	const dispatch = (
		invoke: RemoteInvoke,
		signal: AbortSignal | undefined,
	): { readonly settled: Promise<RemoteToolResult> } => {
		const settled = new Promise<RemoteToolResult>((resolve) => {
			pending.set(invoke.executionId, { resolve });
		});
		if (signal?.aborted) settle(invoke.executionId, errorResult("Operation aborted"));
		else {
			const onAbort = (): void => {
				if (!pending.has(invoke.executionId)) return;
				void transport
					.send(invoke.scope.id, encodeRemoteMessage({ kind: "abort", executionId: invoke.executionId }))
					.catch(() => undefined);
				settle(invoke.executionId, errorResult("Tool execution aborted"));
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			void settled.then(() => signal?.removeEventListener("abort", onAbort));
			transport.send(invoke.scope.id, encodeRemoteMessage(invoke)).catch((error: unknown) => {
				const reason = error instanceof Error ? error.message : String(error);
				settle(invoke.executionId, errorResult(`The hand is unreachable: ${reason}`));
			});
		}
		return { settled };
	};

	return {
		async execute(call: ToolHostCall, hostOptions: ToolHostOptions): Promise<ToolHostResult> {
			const { emit, signal } = hostOptions;
			const batchId = mintId();
			const invokeOf = (raw: AgentToolCall, index: number): RemoteInvoke => ({
				kind: "invoke",
				executionId: mintId(),
				batchId,
				index,
				scope: call.scope,
				toolCallId: raw.id,
				name: raw.name,
				arguments: raw.arguments,
				...(options.sessionRef === undefined ? {} : { sessionRef: options.sessionRef }),
			});
			const finish = async (raw: AgentToolCall, result: RemoteToolResult): Promise<RemoteToolResult> => {
				await emit({
					type: "tool_execution_end",
					toolCallId: raw.id,
					toolName: raw.name,
					result: { ...result, details: result.details },
					isError: result.isError,
				});
				return result;
			};
			const outcomes: Promise<RemoteToolResult>[] = [];
			for (const [index, raw] of call.calls.entries()) {
				await emit({ type: "tool_execution_start", toolCallId: raw.id, toolName: raw.name, args: raw.arguments });
				const outcome = dispatch(invokeOf(raw, index), signal).settled.then((result) => finish(raw, result));
				outcomes.push(outcome);
				if (call.mode === "sequential") {
					await outcome;
					if (signal?.aborted) break;
				}
			}
			const results = await Promise.all(outcomes);
			const messages: ToolResultMessage[] = [];
			for (const [index, result] of results.entries()) {
				const raw = call.calls[index];
				if (raw === undefined) continue;
				const message: ToolResultMessage = {
					role: "toolResult",
					toolCallId: raw.id,
					toolName: raw.name,
					content: result.content,
					details: result.details,
					...(result.addedToolNames?.length ? { addedToolNames: [...result.addedToolNames] } : {}),
					isError: result.isError,
					timestamp: Date.now(),
				};
				await emit({ type: "message_start", message });
				await emit({ type: "message_end", message });
				messages.push(message);
			}
			return {
				messages,
				terminate: results.length > 0 && results.every((result) => result.terminate === true),
			};
		},
		close() {
			for (const executionId of [...pending.keys()])
				settle(executionId, errorResult("The hand link was closed before the call settled"));
			transport.close();
		},
	};
}
