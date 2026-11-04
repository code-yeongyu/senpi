import { TOOL_RESULT_PLACEHOLDER, type ToolResultMessage } from "@earendil-works/pi-ai";
import type { Transport, TransportFrame } from "../transport/transport.ts";
import type { AgentToolCall } from "../types.ts";
import { createEpochGate } from "./remote-epoch-gate.ts";
import {
	decodeRemoteMessage,
	encodeRemoteMessage,
	type RemoteHandMessage,
	type RemoteInvoke,
	type RemoteTerminal,
	type RemoteToolResult,
} from "./remote-protocol.ts";
import type { ToolHost, ToolHostCall, ToolHostOptions, ToolHostResult } from "./tool-host.ts";

/**
 * Where the hand runs relative to the session. It decides what a call that ended without a result (the hand restarted
 * while it ran) looks like to the model, and is always stated, never inferred:
 * - `split-local`: one machine. Recovery equals today's: the call gets today's placeholder result and is not run again.
 * - `cross-machine`: the endpoint contract. The call is reported as uncertain, never run again.
 */
export type HandPlacement = "split-local" | "cross-machine";

export interface RemoteToolHostOptions {
	/** The session's end of the link to the hand; lanes are execution scope IDs. */
	readonly transport: Transport;
	readonly placement: HandPlacement;
	/** What the session says about itself; the hand never acts on it (R16). */
	readonly sessionRef?: string;
	readonly mintId?: () => string;
	/**
	 * The session's owner epoch (brain/hand S35). With it, each scope lane first raises the hand's floor to this epoch
	 * and dispatches only after the hand acked exactly it; every invoke, abort and ack carries it. Without it, nothing
	 * about epochs is sent (a session that never moves).
	 */
	readonly epoch?: number;
}

interface Pending {
	readonly invoke: RemoteInvoke;
	readonly resolve: (result: RemoteToolResult) => void;
}

function errorResult(text: string): RemoteToolResult {
	return { content: [{ type: "text", text }], details: {}, isError: true };
}

function terminalResult(placement: HandPlacement, terminal: RemoteTerminal): RemoteToolResult {
	if (placement === "split-local")
		return { content: [{ type: "text", text: TOOL_RESULT_PLACEHOLDER }], details: {}, isError: false };
	const { reason, uncertain, hooksRan } = terminal;
	const effects = uncertain ? "Its effects are uncertain." : "It had no effect.";
	return {
		content: [
			{ type: "text", text: `The tool call ended without a result (${reason}) and was not run again. ${effects}` },
		],
		details: { outcome: reason, uncertain, hooksRan },
		isError: true,
	};
}

/**
 * The ToolHost that runs a session's tool calls on a hand (brain/hand split, S27a). The hand resolves, prepares,
 * validates, runs the extensions' `tool_call`/`tool_result` handlers (permission checks among them) and executes each
 * call; this host keeps the loop's side: tool events, the batch's ordering, a forwarded abort and the result messages in
 * source order. A call whose send is refused (the transport closed) becomes an error result, never a retry. The one
 * re-send is on a hand's `hello` (it restarted with its durable record): every call still waiting is sent again, and
 * the hand answers each one its record already holds instead of running it a second time.
 */
export function createRemoteToolHost(options: RemoteToolHostOptions): ToolHost & { close(): void } {
	const { transport } = options;
	const mintId = options.mintId ?? (() => crypto.randomUUID());
	const { epoch } = options;
	const stamp = epoch === undefined ? {} : { epoch };
	const pending = new Map<string, Pending>();
	/** Calls handed to the transport: a hand's `hello` re-sends only these, never one still waiting on its floor. */
	const sent = new Set<string>();
	const gate =
		epoch === undefined
			? undefined
			: createEpochGate(epoch, (lane, floor) => transport.send(lane, encodeRemoteMessage(floor)));

	const settle = (executionId: string, result: RemoteToolResult): void => {
		const waiter = pending.get(executionId);
		if (waiter === undefined) return;
		pending.delete(executionId);
		sent.delete(executionId);
		waiter.resolve(result);
	};

	transport.onFrame((frame: TransportFrame) => {
		let message: RemoteHandMessage;
		try {
			message = decodeRemoteMessage(frame.payload);
		} catch {
			return;
		}
		const ack = (executionId: string): void =>
			void transport
				.send(frame.lane, encodeRemoteMessage({ kind: "ack", executionId, ...stamp }))
				.catch(() => undefined);
		if (message.kind === "hello") {
			gate?.resend();
			for (const { invoke } of pending.values())
				if (sent.has(invoke.executionId))
					void transport.send(invoke.scope.id, encodeRemoteMessage(invoke)).catch(() => undefined);
			return;
		}
		if (message.kind === "floor_ack" || message.kind === "floor_refused") return gate?.answer(frame.lane, message);
		if (message.kind === "settled") {
			settle(message.executionId, message.result);
			ack(message.executionId);
		} else if (message.kind === "terminal") {
			settle(message.executionId, terminalResult(options.placement, message));
			ack(message.executionId);
		} else if (message.kind === "refused")
			settle(message.executionId, errorResult(`The hand refused this tool call: ${message.reason}`));
	});

	const dispatch = (
		invoke: RemoteInvoke,
		signal: AbortSignal | undefined,
	): { readonly settled: Promise<RemoteToolResult> } => {
		const settled = new Promise<RemoteToolResult>((resolve) => {
			pending.set(invoke.executionId, { invoke, resolve });
		});
		if (signal?.aborted) settle(invoke.executionId, errorResult("Operation aborted"));
		else {
			const onAbort = (): void => {
				if (!pending.has(invoke.executionId)) return;
				if (sent.has(invoke.executionId))
					void transport
						.send(
							invoke.scope.id,
							encodeRemoteMessage({ kind: "abort", executionId: invoke.executionId, ...stamp }),
						)
						.catch(() => undefined);
				settle(invoke.executionId, errorResult("Tool execution aborted"));
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			void settled.then(() => signal?.removeEventListener("abort", onAbort));
			const send = (): void => {
				if (!pending.has(invoke.executionId)) return;
				sent.add(invoke.executionId);
				transport.send(invoke.scope.id, encodeRemoteMessage(invoke)).catch((error: unknown) => {
					const reason = error instanceof Error ? error.message : String(error);
					settle(invoke.executionId, errorResult(`The hand is unreachable: ${reason}`));
				});
			};
			if (gate === undefined) send();
			else
				void gate.open(invoke.scope.id).then((refusal) => {
					if (refusal === undefined) return send();
					settle(invoke.executionId, errorResult(`The hand refused this session's epoch: ${refusal}`));
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
				...stamp,
				...(options.sessionRef === undefined ? {} : { sessionRef: options.sessionRef }),
			});
			const finish = async (raw: AgentToolCall, result: RemoteToolResult): Promise<RemoteToolResult> => {
				await emit({
					type: "tool_execution_end",
					toolCallId: raw.id,
					toolName: raw.name,
					result,
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
