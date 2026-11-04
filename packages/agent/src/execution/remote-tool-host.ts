import { TOOL_RESULT_PLACEHOLDER, type ToolResultMessage } from "@earendil-works/pi-ai";
import type { Transport } from "../transport/transport.ts";
import type { AgentToolCall } from "../types.ts";
import type { DeviceFiles } from "./device-files.ts";
import { createRemoteDeviceFiles } from "./remote-device-files.ts";
import type { PlaneHandler } from "./plane.ts";
import { createHandLink, type HandReply } from "./remote-link.ts";
import type { RemoteInvoke, RemoteTerminal, RemoteToolResult } from "./remote-protocol.ts";
import type { ExecutionScope, ToolHost, ToolHostCall, ToolHostOptions, ToolHostResult } from "./tool-host.ts";

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
	 * The planes this session serves to its running calls' nested requests (S31), keyed by plane name (`MODEL_PLANE`).
	 * A request is admitted only while its parent call is live on the lane it came on; absent: every request is refused
	 * `plane_unavailable`.
	 */
	readonly planes?: Readonly<Record<string, PlaneHandler>>;
	/**
	 * The planes a pending device file operation (S40) may host, on its own lane: a two-sided extension's forwarded tool
	 * events (S29), so its handler runs on the loop's copy for a file operation as for a tool call. Absent: none, so
	 * every nested request under a file operation is refused `parent_terminal`.
	 */
	readonly filePlanes?: readonly string[];
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
 * re-send is on a durable hand's `hello` (see `createHandLink`). `deviceFiles(scope)` reaches the hand's files (S40).
 */
export function createRemoteToolHost(
	options: RemoteToolHostOptions,
): ToolHost & { deviceFiles(scope: ExecutionScope): DeviceFiles; close(): void } {
	const mintId = options.mintId ?? (() => crypto.randomUUID());
	const link = createHandLink(options.transport, options.planes ?? {}, options.filePlanes ?? []);

	const resultOf = (reply: HandReply): RemoteToolResult => {
		switch (reply.kind) {
			case "settled":
				return reply.result;
			case "terminal":
				return terminalResult(options.placement, reply.terminal);
			case "refused":
				return errorResult(`The hand refused this tool call: ${reply.reason}`);
			case "aborted":
				return errorResult(reply.sent ? "Tool execution aborted" : "Operation aborted");
			case "unreachable":
				return errorResult(`The hand is unreachable: ${reply.reason}`);
			case "closed":
				return errorResult("The hand link was closed before the call settled");
		}
	};
	const dispatch = (
		invoke: RemoteInvoke,
		signal: AbortSignal | undefined,
	): { readonly settled: Promise<RemoteToolResult> } => ({
		settled: link.dispatch(invoke, signal).then(resultOf),
	});

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
		deviceFiles: (scope) => createRemoteDeviceFiles(link, scope, mintId),
		close: () => link.close(),
	};
}
