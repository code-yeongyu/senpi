/**
 * Cursor agent protocol (`agent.v1.AgentService/Run`) over HTTP/2 Connect.
 *
 * Ported from upstream oh-my-pi's Cursor provider and adapted to senpi's
 * provider-neutral API architecture. The protocol is server-driven: the
 * client opens one `Run` stream per assistant turn, the server streams
 * interaction updates (text/thinking/tool-call deltas) and, mid-turn, sends
 * `ExecServerMessage` frames asking the CLIENT to execute a tool and blocks
 * until the answer arrives on the same stream. Tool execution is therefore
 * bridged through injected {@link CursorExecHandlers}; each bridged call is
 * synthesized into the assistant message as an already-resolved `toolCall`
 * block (marked {@link kCursorExecResolved} so the agent loop never re-runs
 * it) and paired with a `ToolResultMessage` delivered via `onToolResult`.
 *
 * NOTE: This module is Node-only (node:http2) and must only be reached
 * through the lazy wrapper (`cursor-agent.lazy.ts`).
 */

import { createHash, randomUUID } from "node:crypto";
import * as http2 from "node:http2";
import { create, fromBinary, fromJson, type JsonValue as PbJsonValue, toBinary, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { calculateCost } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	Context,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../types.ts";
import {
	type CursorExecResolvedCarrier,
	clearStreamingPartialJson,
	kCursorExecResolved,
	kStreamingBlockIndex,
	kStreamingBlockKind,
	kStreamingEnvelopeId,
	kStreamingLastParseLen,
	kStreamingPartialJson,
} from "../utils/block-symbols.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { providerHeadersToRecord } from "../utils/headers.ts";
import { parseJsonWithRepair, parseStreamingJson } from "../utils/json-parse.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { deterministicUuid } from "./cursor-agent/deterministic-id.ts";
import { armExecHeartbeat } from "./cursor-agent/exec-lifecycle.ts";
import {
	buildMcpStateResult,
	buildNeutralHookResult,
	buildPiBashError,
	buildPiBashResult,
	buildPiEditError,
	buildPiEditRejected,
	buildPiEditResult,
	buildPiFindError,
	buildPiFindResult,
	buildPiGrepError,
	buildPiGrepResult,
	buildPiLsError,
	buildPiLsResult,
	buildPiReadError,
	buildPiReadResult,
	buildPiWriteError,
	buildPiWriteRejected,
	buildPiWriteResult,
} from "./cursor-agent/exec-modern.ts";
import {
	AgentClientMessageSchema,
	AgentConversationTurnStructureSchema,
	AgentRunRequestSchema,
	type AgentServerMessage,
	AgentServerMessageSchema,
	AgentStoreConflictErrorSchema,
	AgentStoreConflictResultSchema,
	AssistantMessageSchema,
	BackgroundShellSpawnResultSchema,
	CanvasDiagnosticsErrorSchema,
	CanvasDiagnosticsResultSchema,
	ClientHeartbeatSchema,
	ComputerUseErrorSchema,
	ComputerUseResultSchema,
	ConversationActionSchema,
	ConversationSearchErrorSchema,
	ConversationSearchResultSchema,
	type ConversationStateStructure,
	ConversationStateStructureSchema,
	type ConversationStep,
	ConversationStepSchema,
	ConversationTurnStructureSchema,
	DeleteErrorSchema,
	DeleteRejectedSchema,
	DeleteResultSchema,
	DeleteSuccessSchema,
	DiagnosticsErrorSchema,
	DiagnosticsRejectedSchema,
	DiagnosticsResultSchema,
	DiagnosticsSuccessSchema,
	ExecClientControlMessageSchema,
	ExecClientHeartbeatSchema,
	type ExecClientMessage,
	ExecClientMessageSchema,
	ExecClientStreamCloseSchema,
	ExecClientThrowSchema,
	type ExecServerMessage,
	FetchErrorSchema,
	FetchResultSchema,
	ForceBackgroundShellResultSchema,
	ForceBackgroundShellStatus,
	ForceBackgroundSubagentResultSchema,
	ForceBackgroundSubagentStatus,
	GetBlobResultSchema,
	GetUsableModelsRequestSchema,
	GetUsableModelsResponseSchema,
	GrepContentMatchSchema,
	GrepContentResultSchema,
	GrepCountResultSchema,
	GrepErrorSchema,
	type GrepFileCount,
	GrepFileCountSchema,
	GrepFileMatchSchema,
	GrepFilesResultSchema,
	GrepResultSchema,
	GrepSuccessSchema,
	type GrepUnionResult,
	GrepUnionResultSchema,
	KvClientMessageSchema,
	type KvServerMessage,
	ListMcpResourcesExecResultSchema,
	ListMcpResourcesSuccessSchema,
	type LsDirectoryTreeNode,
	type LsDirectoryTreeNode_File,
	LsDirectoryTreeNode_FileSchema,
	LsDirectoryTreeNodeSchema,
	LsErrorSchema,
	LsRejectedSchema,
	LsResultSchema,
	LsSuccessSchema,
	McpAllowlistPrecheckResultSchema,
	McpApprovedSchema,
	McpArgsSchema,
	McpErrorSchema,
	McpImageContentSchema,
	McpRejectedSchema,
	McpResultSchema,
	McpSuccessSchema,
	McpTextContentSchema,
	McpToolCallSchema,
	type McpToolDefinition,
	McpToolDefinitionSchema,
	McpToolErrorSchema,
	McpToolNotFoundSchema,
	McpToolResultContentItemSchema,
	McpToolResultSchema,
	ModelDetailsSchema,
	ReadErrorSchema,
	ReadMcpResourceExecResultSchema,
	ReadMcpResourceNotFoundSchema,
	ReadRejectedSchema,
	ReadResultSchema,
	ReadSuccessSchema,
	RecordScreenFailureSchema,
	RecordScreenResultSchema,
	RequestContextResultSchema,
	RequestContextSchema,
	RequestContextSuccessSchema,
	RequestedModelSchema,
	ResumeActionSchema,
	SelectedContextSchema,
	SelectedImageSchema,
	SetBlobResultSchema,
	ShellAllowlistPrecheckResultSchema,
	type ShellArgs,
	ShellFailureSchema,
	ShellRejectedSchema,
	type ShellResult,
	ShellResultSchema,
	type ShellStream,
	ShellStreamExitSchema,
	ShellStreamSchema,
	ShellStreamStartSchema,
	ShellStreamStderrSchema,
	ShellStreamStdoutSchema,
	ShellSuccessSchema,
	SmartModeClassifierErrorSchema,
	SmartModeClassifierResultSchema,
	SubagentAwaitNotFoundSchema,
	SubagentAwaitResultSchema,
	SubagentErrorSchema,
	SubagentResultSchema,
	ToolCallSchema,
	UserMessageActionSchema,
	UserMessageSchema,
	WebFetchAllowlistPrecheckResultSchema,
	WriteErrorSchema,
	WriteRejectedSchema,
	WriteResultSchema,
	WriteShellStdinErrorSchema,
	WriteShellStdinResultSchema,
	WriteSuccessSchema,
} from "./cursor-agent/gen/agent_pb.ts";
import {
	composeShellCommand,
	omitUndefinedArgs,
	piLimit,
	piLsPath,
	piReadArgs,
	piTimeout,
} from "./cursor-agent/pi-args.ts";
import type {
	CursorAgentOptions,
	CursorExecHandlerResult,
	CursorExecHandlers,
	CursorExecPairing,
	CursorMcpCall,
	CursorShellStreamCallbacks,
	CursorToolResultHandler,
} from "./cursor-agent/types.ts";

export type {
	CursorAgentOptions,
	CursorExecHandlerResult,
	CursorExecHandlers,
	CursorExecPairing,
	CursorMcpCall,
	CursorPiCall,
	CursorShellStreamCallbacks,
	CursorToolResultHandler,
} from "./cursor-agent/types.ts";

export const CURSOR_API_URL = "https://api2.cursor.sh";
export const CURSOR_CLIENT_VERSION = "cli-2026.07.23-e383d2b";
const EXEC_HEARTBEAT_INTERVAL_MS = 3000;

/**
 * HTTP/1 connection-specific headers that HTTP/2 forbids. Node's
 * `http2.request()` throws on these rather than dropping them.
 */
const HTTP2_FORBIDDEN_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-connection",
	"transfer-encoding",
	"upgrade",
	"http2-settings",
]);

/**
 * Header names the Cursor request sets for itself. A caller copy in ANY
 * casing has to go: the spread below adds the fixed lower-case name
 * regardless, and two spellings of one field are a duplicate (node throws
 * `ERR_HTTP2_HEADER_SINGLE_VALUE`) rather than an override.
 */
const CURSOR_RESERVED_HEADERS = new Set([
	"content-type",
	"connect-protocol-version",
	"te",
	"authorization",
	"x-ghost-mode",
	"x-cursor-client-version",
	"x-cursor-client-type",
	"x-request-id",
	// Transport-owned: a plain `host` header suppresses the `:authority` node
	// derives from the URL, silently retargeting the request.
	"host",
	// The Connect body is streamed after the headers (initial frame,
	// heartbeats, tool responses), so no caller-supplied length can describe it.
	"content-length",
]);

/** Reduce caller-supplied headers to what this HTTP/2 request can legally carry. */
export function sanitizeCursorCallerHeaders(headers: Record<string, string> | undefined): Record<string, string> {
	const sanitized: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers ?? {})) {
		const field = name.toLowerCase();
		if (field.startsWith(":")) continue;
		if (HTTP2_FORBIDDEN_HEADERS.has(field)) continue;
		if (CURSOR_RESERVED_HEADERS.has(field)) continue;
		sanitized[field] = value;
	}
	return sanitized;
}

/**
 * Text for a recognised frame this client answers with its own typed error
 * variant. Phrased as a client capability statement, not a tool failure: the
 * model reads it and should route around the capability, not retry the call.
 */
const NOT_IMPLEMENTED_SUFFIX = "not implemented by this client";
const NOT_IMPLEMENTED = "Not implemented by this client";
/** Bare gRPC `resource_exhausted` end-streams (also inside a Connect error message). */
const RESOURCE_EXHAUSTED_PATTERN = /resource.?exhausted/i;

const conversationStateCache = new Map<string, ConversationStateStructure>();
const conversationBlobStores = new Map<string, Map<string, Uint8Array>>();
/**
 * Base conversation id → rotated wire id. Cursor's backend can pin a
 * per-conversation rejection (bare `resource_exhausted`, zero tokens) to one
 * conversationId forever. On the first such failure the id is rotated once
 * and the cached state migrates, so the retry loop's next attempt starts a
 * fresh conversation. Keyed by the base id so a failed rotation never repeats.
 */
const rotatedConversationIds = new Map<string, string>();

const CONNECT_END_STREAM_FLAG = 0b00000010;

function log(type: string, subtype?: string, data?: unknown): void {
	if (!process.env.DEBUG_CURSOR) return;
	const verbose = process.env.DEBUG_CURSOR === "2" || process.env.DEBUG_CURSOR === "verbose";
	let dataStr = "";
	if (verbose && data !== undefined) {
		try {
			dataStr = ` ${JSON.stringify(data, (_key, value) => {
				if (value instanceof Uint8Array) return `bytes(${value.length})`;
				if (typeof value === "bigint") return value.toString();
				return value;
			})?.slice(0, 500)}`;
		} catch {
			dataStr = " [unserializable]";
		}
	}
	console.error(`[CURSOR] ${type}${subtype ? `: ${subtype}` : ""}${dataStr}`);
}

export function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
	const frame = Buffer.alloc(5 + data.length);
	frame[0] = flags;
	frame.writeUInt32BE(data.length, 1);
	frame.set(data, 5);
	return frame;
}

function parseConnectEndStream(data: Uint8Array): Error | null {
	try {
		const payload = JSON.parse(new TextDecoder().decode(data));
		const error = payload?.error;
		if (error) {
			const code = typeof error.code === "string" ? error.code : "unknown";
			const message = typeof error.message === "string" ? error.message : "Unknown error";
			return new Error(`Connect error ${code}: ${message}`);
		}
		return null;
	} catch {
		return new Error("Failed to parse Connect end stream");
	}
}

/**
 * Maps an opaque HTTP/2 negotiation failure into an actionable error. The
 * Cursor run RPC is HTTP/2-only (the ALB rejects HTTP/1.1 with 464), so a
 * TLS-intercepting proxy that strips ALPN kills the run with no h1 fallback.
 */
export function mapH2TransportError(error: unknown, baseUrl: string): unknown {
	const code = (error as { code?: unknown } | null)?.code;
	const message = error instanceof Error ? error.message : String(error);
	if (code === "ERR_HTTP2_ERROR" && /h2 is not supported/i.test(message)) {
		return new Error(
			`Cursor run transport could not negotiate HTTP/2 with ${baseUrl}: "h2 is not supported". ` +
				"This host serves the run RPC over HTTP/2 only, and the TLS handshake did not negotiate " +
				"h2 via ALPN — typically an ALPN-stripping TLS-intercepting proxy. " +
				"Front the provider with a local HTTP/2 bridge and point the model's baseUrl at it.",
		);
	}
	return error;
}

export const stream: StreamFunction<"cursor-agent", CursorAgentOptions> = (
	model: Model<"cursor-agent">,
	context: Context,
	options?: CursorAgentOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "cursor-agent" as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		// Declared outside the `try` because BOTH exits must drain it: an exec
		// handler decoded from the last chunk can still be running when the
		// transport fails, and the error path finalizes the synthesized call
		// just like the success path does.
		const inFlightDispatches = new Set<Promise<void>>();
		// A dispatch can spawn another, so re-check rather than awaiting one
		// snapshot. The wait is bounded by the abort signal: exec handlers have
		// no cancellation contract, so a hung tool must not hold the terminal
		// event hostage after the user already gave up on the turn.
		let abortSettled: Promise<void> | undefined;
		const drainInFlightDispatches = async (): Promise<void> => {
			const signal = options?.signal;
			while (inFlightDispatches.size > 0) {
				if (signal?.aborted) return;
				const settled = Promise.all([...inFlightDispatches]);
				if (!signal) {
					await settled;
					continue;
				}
				abortSettled ??= new Promise<void>((resolve) =>
					signal.addEventListener("abort", () => resolve(), { once: true }),
				);
				await Promise.race([settled, abortSettled]);
			}
		};

		let h2Client: http2.ClientHttp2Session | null = null;
		let h2Request: http2.ClientHttp2Stream | null = null;
		let heartbeatTimer: NodeJS.Timeout | null = null;
		let h2Settled = false;
		let sawTurnEnded = false;
		let endStreamError: Error | null = null;
		// Reachable from the catch: a stream that dies mid-turn must still close
		// and pair the blocks it left open.
		let openBlockState: BlockState | undefined;
		let resolveH2: () => void = () => {};
		let rejectH2: (error: unknown) => void = () => {};
		const h2Completion = new Promise<void>((resolve, reject) => {
			resolveH2 = resolve;
			rejectH2 = reject;
		});
		const settleH2 = (error?: unknown): void => {
			if (h2Settled) return;
			h2Settled = true;
			if (error !== undefined) {
				rejectH2(error);
				return;
			}
			if (endStreamError) {
				rejectH2(endStreamError);
				return;
			}
			if (!sawTurnEnded) {
				rejectH2(new Error("Cursor stream ended before turnEnded"));
				return;
			}
			resolveH2();
		};

		// Hoisted out of the try block: the rotation in the catch path needs
		// both ids, and the catch block cannot see try-scoped consts.
		let baseConversationId: string | undefined;
		let conversationId: string | undefined;
		let usageState: UsageState | undefined;
		try {
			const apiKey = options?.apiKey;
			if (!apiKey) {
				throw new Error("Cursor access token is required; run /login cursor");
			}

			baseConversationId = options?.conversationId ?? options?.sessionId ?? randomUUID();
			conversationId = rotatedConversationIds.get(baseConversationId) ?? baseConversationId;
			const blobStore = conversationBlobStores.get(conversationId) ?? new Map<string, Uint8Array>();
			conversationBlobStores.set(conversationId, blobStore);
			const cachedState = conversationStateCache.get(conversationId);
			const { requestBytes, conversationState } = await buildGrpcRequest(model, context, options, {
				conversationId,
				blobStore,
				conversationState: cachedState,
			});
			conversationStateCache.set(conversationId, conversationState);
			const requestContextTools = buildMcpToolDefinitions(context.tools);

			const baseUrl = model.baseUrl || CURSOR_API_URL;
			const requestPath = "/agent.v1.AgentService/Run";
			// Caller headers are additive, and are spread FIRST so the protocol
			// framing, auth, and request id below always win.
			const callerHeaders = sanitizeCursorCallerHeaders(providerHeadersToRecord(options?.headers));
			const requestHeaders = {
				...callerHeaders,
				":method": "POST",
				":path": requestPath,
				"content-type": "application/connect+proto",
				"connect-protocol-version": "1",
				te: "trailers",
				authorization: `Bearer ${apiKey}`,
				"x-ghost-mode": "true",
				"x-cursor-client-version": CURSOR_CLIENT_VERSION,
				"x-cursor-client-type": "cli",
				"x-request-id": randomUUID(),
			};

			h2Client = http2.connect(baseUrl);
			h2Client.on("error", (error) => settleH2(mapH2TransportError(error, baseUrl)));

			h2Request = h2Client.request(requestHeaders);

			stream.push({ type: "start", partial: output });

			let pendingBuffer: Buffer = Buffer.alloc(0);
			let currentTextBlock: (TextContent & { [kStreamingBlockIndex]: number }) | null = null;
			let currentThinkingBlock: (ThinkingContent & { [kStreamingBlockIndex]: number }) | null = null;
			let currentToolCall: ToolCallState | null = null;
			const resolvedMcpToolCallIds = new Set<string>();
			usageState = { sawTokenDelta: false };

			const state: BlockState = {
				get currentTextBlock() {
					return currentTextBlock;
				},
				get currentThinkingBlock() {
					return currentThinkingBlock;
				},
				get currentToolCall() {
					return currentToolCall;
				},
				openToolCalls: new Map<string, ToolCallState>(),
				resolvedMcpToolCallIds,
				setTextBlock: (b) => {
					currentTextBlock = b;
				},
				setThinkingBlock: (b) => {
					currentThinkingBlock = b;
				},
				setToolCall: (t) => {
					currentToolCall = t;
				},
				onToolResult: options?.onToolResult ?? options?.execHandlers?.onToolResult,
			};
			openBlockState = state;

			const onConversationCheckpoint = (checkpoint: ConversationStateStructure) => {
				conversationStateCache.set(conversationId!, checkpoint);
			};

			h2Request.on("data", (chunk: Buffer) => {
				// Steady state drains fully per chunk; alias the fresh h2 chunk
				// instead of copying it through Buffer.concat.
				pendingBuffer = pendingBuffer.length === 0 ? chunk : Buffer.concat([pendingBuffer, chunk]);

				while (pendingBuffer.length >= 5) {
					const flags = pendingBuffer[0];
					const msgLen = pendingBuffer.readUInt32BE(1);
					if (pendingBuffer.length < 5 + msgLen) break;

					const messageBytes = pendingBuffer.subarray(5, 5 + msgLen);
					pendingBuffer = pendingBuffer.subarray(5 + msgLen);

					if (flags & CONNECT_END_STREAM_FLAG) {
						const endError = parseConnectEndStream(messageBytes);
						if (endError) {
							endStreamError = endError;
							h2Request?.close();
						}
						continue;
					}

					try {
						const serverMessage = fromBinary(AgentServerMessageSchema, messageBytes);
						const isTurnEnded =
							serverMessage.message.case === "interactionUpdate" &&
							serverMessage.message.value.message?.case === "turnEnded";
						// Dispatch is fire-and-forget so the socket keeps draining
						// while a handler runs, but the promise is tracked: `done`
						// must not be pushed while an exec handler is still resolving,
						// or the buffered tool result is delivered after the turn
						// already finalized and the call is left unpaired.
						const dispatch = handleServerMessage(
							serverMessage,
							output,
							stream,
							state,
							blobStore,
							h2Request!,
							options?.execHandlers,
							state.onToolResult,
							usageState!,
							requestContextTools,
							onConversationCheckpoint,
						).catch((error) => {
							log("error", "handleServerMessage", { error: String(error) });
						});
						inFlightDispatches.add(dispatch);
						void dispatch.finally(() => inFlightDispatches.delete(dispatch));

						// Application completion is not protocol success; wait for a
						// clean HTTP/2 end.
						if (isTurnEnded) {
							sawTurnEnded = true;
						}
					} catch (e) {
						log("error", "parseServerMessage", { error: String(e) });
					}
				}
			});

			const sendHeartbeat = () => {
				if (!h2Request || h2Request.closed) {
					return;
				}
				const heartbeatMessage = create(AgentClientMessageSchema, {
					message: { case: "clientHeartbeat", value: create(ClientHeartbeatSchema, {}) },
				});
				const heartbeatBytes = toBinary(AgentClientMessageSchema, heartbeatMessage);
				h2Request.write(frameConnectMessage(heartbeatBytes));
			};

			h2Request.on("trailers", (trailers) => {
				const status = trailers["grpc-status"];
				const msg = trailers["grpc-message"];
				if (status && status !== "0" && !endStreamError) {
					endStreamError = new Error(`gRPC error ${status}: ${decodeURIComponent(String(msg || ""))}`);
				}
			});

			h2Request.on("end", () => {
				settleH2();
			});

			h2Request.on("error", (error) => {
				settleH2(mapH2TransportError(error, baseUrl));
			});

			if (options?.signal) {
				options.signal.addEventListener("abort", () => {
					h2Request?.close();
					settleH2(new Error("Request was aborted"));
				});
			}

			h2Request.write(frameConnectMessage(requestBytes));
			heartbeatTimer = setInterval(sendHeartbeat, 5000);
			await h2Completion;
			// The transport is done, but a handler decoded from the last chunk
			// may still be running. Pushing `done` now would let the host drain
			// its buffered tool results before such a handler reserved its entry,
			// leaving the call unpaired and stripped from rebuilt transcripts.
			await drainInFlightDispatches();

			endCurrentTextBlock(output, stream, state);
			endCurrentThinkingBlock(output, stream, state);
			flushOpenToolCalls(output, stream, state);

			calculateCost(model, output.usage);

			stream.push({
				type: "done",
				reason: output.stopReason as "stop" | "length" | "toolUse",
				message: output,
			});
			stream.end();
		} catch (error) {
			// Same reason as the success path: a handler still running would land
			// its real result after the turn finalized and be discarded — even
			// though the tool may already have run side effects. On abort the
			// drain returns immediately.
			await drainInFlightDispatches();
			// A stream that dies mid-turn leaves blocks open. Closing them here
			// settles their live cards and pairs the server-owned calls that
			// nothing else answers — an unpaired call is stripped from every
			// rebuilt transcript.
			if (openBlockState) {
				endCurrentTextBlock(output, stream, openBlockState);
				endCurrentThinkingBlock(output, stream, openBlockState);
				flushOpenToolCalls(output, stream, openBlockState);
			}
			const message = error instanceof Error ? error.message : JSON.stringify(error);
			// A server-side per-conversation rejection surfaces as a bare
			// resource_exhausted with zero tokens — the conversation is poisoned,
			// not the account. Rotate the wire id once and migrate cached state
			// so the caller's retry loop starts a fresh conversation.
			if (
				conversationId !== undefined &&
				baseConversationId !== undefined &&
				usageState !== undefined &&
				!usageState.sawTokenDelta &&
				RESOURCE_EXHAUSTED_PATTERN.test(message) &&
				!rotatedConversationIds.has(baseConversationId)
			) {
				const rotated = randomUUID();
				rotatedConversationIds.set(baseConversationId, rotated);
				const cached = conversationStateCache.get(conversationId);
				if (cached) conversationStateCache.set(rotated, cached);
				const blobs = conversationBlobStores.get(conversationId);
				if (blobs) conversationBlobStores.set(rotated, blobs);
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = message;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		} finally {
			if (heartbeatTimer) {
				clearInterval(heartbeatTimer);
				heartbeatTimer = null;
			}
			h2Request?.close();
			h2Client?.close();
		}
	})();

	return stream;
};

/**
 * `streamSimple` for Cursor: reasoning/thinking is managed server-side per
 * model (there is no client thinking knob on the Run request), so the simple
 * options map through unchanged.
 */
export const streamSimple: StreamFunction<"cursor-agent", SimpleStreamOptions> = (
	model: Model<"cursor-agent">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	return stream(model, context, options as CursorAgentOptions);
};

export type ToolCallState = ToolCall & {
	[kStreamingBlockIndex]: number;
	[kStreamingPartialJson]?: string;
	[kStreamingLastParseLen]?: number;
	[kStreamingBlockKind]: "mcp" | "todo" | "cursor-exec" | "connect-scm";
	[kStreamingEnvelopeId]?: string;
	[kCursorExecResolved]?: true;
};

export interface BlockState {
	currentTextBlock: (TextContent & { [kStreamingBlockIndex]: number }) | null;
	currentThinkingBlock: (ThinkingContent & { [kStreamingBlockIndex]: number }) | null;
	currentToolCall: ToolCallState | null;
	/**
	 * Open streamed tool-call blocks, keyed by the interaction envelope's
	 * `call_id`. Cursor interleaves calls: two `toolCallStarted` frames can
	 * arrive before either completes.
	 */
	openToolCalls: Map<string, ToolCallState>;
	/** MCP call IDs synthesized from exec frames before their redundant streamed block arrives. */
	resolvedMcpToolCallIds: Set<string>;
	setTextBlock: (b: (TextContent & { [kStreamingBlockIndex]: number }) | null) => void;
	setThinkingBlock: (b: (ThinkingContent & { [kStreamingBlockIndex]: number }) | null) => void;
	setToolCall: (t: ToolCallState | null) => void;
	/**
	 * Persist a paired `toolResult` for a server-resolved call. Native todo
	 * calls never travel the exec channel, so without this the resolved block
	 * has no matching result and every transcript rebuild strips it as dangling.
	 */
	onToolResult?: CursorToolResultHandler;
}

function markCursorExecResolved(block: CursorExecResolvedCarrier): void {
	block[kCursorExecResolved] = true;
}

export interface UsageState {
	sawTokenDelta: boolean;
}

/** Exported for tests: drives one Cursor server message through the stream (exec waits mark the stream busy). */
export async function handleServerMessage(
	msg: AgentServerMessage,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: BlockState,
	blobStore: Map<string, Uint8Array>,
	h2Request: http2.ClientHttp2Stream,
	execHandlers: CursorExecHandlers | undefined,
	onToolResult: CursorToolResultHandler | undefined,
	usageState: UsageState,
	requestContextTools: McpToolDefinition[],
	onConversationCheckpoint?: (checkpoint: ConversationStateStructure) => void,
): Promise<void> {
	const msgCase = msg.message.case;

	log("serverMessage", msgCase);

	if (msgCase === "interactionUpdate") {
		processInteractionUpdate(msg.message.value, output, stream, state, usageState);
	} else if (msgCase === "kvServerMessage") {
		handleKvServerMessage(msg.message.value as KvServerMessage, blobStore, h2Request);
	} else if (msgCase === "execServerMessage") {
		// The server is waiting on OUR local tool result during this window — no
		// AssistantMessageEvent flows until the handler finishes. Mark the wait
		// as local work so idle watchdogs attribute the silence to the tool run
		// instead of aborting a healthy stream.
		await stream.trackLocalWork(
			handleExecServerMessage(
				msg.message.value as ExecServerMessage,
				h2Request,
				execHandlers,
				onToolResult,
				requestContextTools,
				output,
				stream,
				state,
			),
		);
	} else if (msgCase === "conversationCheckpointUpdate") {
		onConversationCheckpoint?.(msg.message.value);
	}
}

function handleKvServerMessage(
	kvMsg: KvServerMessage,
	blobStore: Map<string, Uint8Array>,
	h2Request: http2.ClientHttp2Stream,
): void {
	const kvCase = kvMsg.message.case;

	if (kvCase === "getBlobArgs") {
		const blobId = kvMsg.message.value.blobId;
		const blobIdKey = Buffer.from(blobId).toString("hex");
		const blobData = blobStore.get(blobIdKey);
		const response = create(KvClientMessageSchema, {
			id: kvMsg.id,
			message: {
				case: "getBlobResult",
				value: create(GetBlobResultSchema, blobData ? { blobData } : {}),
			},
		});
		const kvClientMessage = create(AgentClientMessageSchema, {
			message: { case: "kvClientMessage", value: response },
		});
		h2Request.write(frameConnectMessage(toBinary(AgentClientMessageSchema, kvClientMessage)));
		log("kvClient", "getBlobResult", { blobId: blobIdKey.slice(0, 40) });
	} else if (kvCase === "setBlobArgs") {
		const { blobId, blobData } = kvMsg.message.value;
		const blobIdKey = Buffer.from(blobId).toString("hex");
		blobStore.set(blobIdKey, blobData);
		const response = create(KvClientMessageSchema, {
			id: kvMsg.id,
			message: {
				case: "setBlobResult",
				value: create(SetBlobResultSchema, {}),
			},
		});
		const kvClientMessage = create(AgentClientMessageSchema, {
			message: { case: "kvClientMessage", value: response },
		});
		h2Request.write(frameConnectMessage(toBinary(AgentClientMessageSchema, kvClientMessage)));
		log("kvClient", "setBlobResult", { blobId: blobIdKey.slice(0, 40) });
	}
}

function sendShellStreamEvent(
	h2Request: http2.ClientHttp2Stream,
	execMsg: ExecServerMessage,
	event: ShellStream["event"],
): void {
	sendExecClientMessage(h2Request, execMsg, "shellStream", create(ShellStreamSchema, { event }));
}

function sanitizeShellExecResult(execResult: ShellResult): ShellResult {
	const result = execResult.result;
	if (!result) return execResult;

	switch (result.case) {
		case "success":
		case "failure": {
			const value = result.value;
			return {
				...execResult,
				result: {
					case: result.case,
					value: {
						...value,
						stdout: value.stdout ? sanitizeSurrogates(value.stdout) : value.stdout,
						stderr: value.stderr ? sanitizeSurrogates(value.stderr) : value.stderr,
					},
				},
			} as ShellResult;
		}
		default:
			return execResult;
	}
}

async function handleShellStreamArgs(
	args: ShellArgs,
	execMsg: ExecServerMessage,
	h2Request: http2.ClientHttp2Stream,
	execHandlers: CursorExecHandlers | undefined,
	onToolResult: CursorToolResultHandler | undefined,
): Promise<void> {
	const normalizedWorkingDirectory = args.workingDirectory || process.cwd();
	const normalizedArgs: ShellArgs = { ...args, workingDirectory: normalizedWorkingDirectory };

	sendShellStreamEvent(h2Request, execMsg, { case: "start", value: create(ShellStreamStartSchema, {}) });

	// Buffer for incomplete ANSI sequences across chunks.
	let stdoutBuffer = "";
	let stderrBuffer = "";

	const incompleteEscapeRegex = /\x1b(|\[|\[\d*|\[\?|\[\?\d*|\]\d*;?)$/;

	const flushStdout = () => {
		if (stdoutBuffer) {
			let safeEnd = stdoutBuffer.length;
			const match = stdoutBuffer.match(incompleteEscapeRegex);
			if (match && match[0].length > 0) {
				safeEnd = stdoutBuffer.length - match[0].length;
			}
			const toSend = stdoutBuffer.slice(0, safeEnd);
			const remaining = stdoutBuffer.slice(safeEnd);
			if (toSend) {
				sendShellStreamEvent(h2Request, execMsg, {
					case: "stdout",
					value: create(ShellStreamStdoutSchema, { data: sanitizeSurrogates(toSend) }),
				});
			}
			stdoutBuffer = remaining;
		}
	};

	const flushStderr = () => {
		if (stderrBuffer) {
			let safeEnd = stderrBuffer.length;
			const match = stderrBuffer.match(incompleteEscapeRegex);
			if (match && match[0].length > 0) {
				safeEnd = stderrBuffer.length - match[0].length;
			}
			const toSend = stderrBuffer.slice(0, safeEnd);
			const remaining = stderrBuffer.slice(safeEnd);
			if (toSend) {
				sendShellStreamEvent(h2Request, execMsg, {
					case: "stderr",
					value: create(ShellStreamStderrSchema, { data: sanitizeSurrogates(toSend) }),
				});
			}
			stderrBuffer = remaining;
		}
	};

	let stdoutFlushTimer: NodeJS.Timeout | null = null;
	let stderrFlushTimer: NodeJS.Timeout | null = null;

	const scheduleStdoutFlush = () => {
		if (!stdoutFlushTimer) {
			stdoutFlushTimer = setTimeout(() => {
				stdoutFlushTimer = null;
				flushStdout();
			}, 100);
		}
	};

	const scheduleStderrFlush = () => {
		if (!stderrFlushTimer) {
			stderrFlushTimer = setTimeout(() => {
				stderrFlushTimer = null;
				flushStderr();
			}, 100);
		}
	};

	const streamCallbacks: CursorShellStreamCallbacks = {
		onStdout(data: string) {
			stdoutBuffer += data;
			if (stdoutBuffer.includes("\n") || stdoutBuffer.length > 4096) {
				if (stdoutFlushTimer) {
					clearTimeout(stdoutFlushTimer);
					stdoutFlushTimer = null;
				}
				flushStdout();
			} else {
				scheduleStdoutFlush();
			}
		},
		onStderr(data: string) {
			stderrBuffer += data;
			if (stderrBuffer.includes("\n") || stderrBuffer.length > 4096) {
				if (stderrFlushTimer) {
					clearTimeout(stderrFlushTimer);
					stderrFlushTimer = null;
				}
				flushStderr();
			} else {
				scheduleStderrFlush();
			}
		},
	};

	// Prefer the streaming handler — it forwards output chunks in real time.
	const streamHandler = execHandlers?.shellStream?.bind(execHandlers);
	const batchHandler = execHandlers?.shell?.bind(execHandlers);
	const handler = streamHandler ? (shellArgs: ShellArgs) => streamHandler(shellArgs, streamCallbacks) : batchHandler;

	const { execResult } = await resolveExecHandler(
		normalizedArgs,
		handler as typeof batchHandler,
		onToolResult,
		(toolResult) => buildShellResultFromToolResult(normalizedArgs, toolResult),
		(reason) => buildShellRejectedResult(normalizedArgs.command, normalizedArgs.workingDirectory, reason),
		(error) => buildShellFailureResult(normalizedArgs.command, normalizedArgs.workingDirectory, error),
		{ toolCallId: args.toolCallId, toolName: "bash" },
	);

	// When using the batch handler (no shellStream), send buffered stdout/stderr
	// after execution completes. With shellStream these were already sent live.
	const sendBufferedOutput = !streamHandler;
	const sanitizedExecResult = sanitizeShellExecResult(execResult);

	if (stdoutFlushTimer) clearTimeout(stdoutFlushTimer);
	if (stderrFlushTimer) clearTimeout(stderrFlushTimer);
	flushStdout();
	flushStderr();

	sendShellStreamExitFromResult(h2Request, execMsg, sanitizedExecResult, sendBufferedOutput);
	// Cursor can keep the turn pending when it receives only stream deltas.
	// Send the final structured shellResult as completion acknowledgement.
	sendExecClientMessage(h2Request, execMsg, "shellResult", sanitizedExecResult);
}

function sendShellStreamExitFromResult(
	h2Request: http2.ClientHttp2Stream,
	execMsg: ExecServerMessage,
	execResult: ShellResult,
	sendBufferedOutput: boolean,
): void {
	const result = execResult.result;
	switch (result.case) {
		case "success": {
			const value = result.value;
			if (sendBufferedOutput) {
				if (value.stdout) {
					sendShellStreamEvent(h2Request, execMsg, {
						case: "stdout",
						value: create(ShellStreamStdoutSchema, { data: sanitizeSurrogates(value.stdout) }),
					});
				}
				if (value.stderr) {
					sendShellStreamEvent(h2Request, execMsg, {
						case: "stderr",
						value: create(ShellStreamStderrSchema, { data: sanitizeSurrogates(value.stderr) }),
					});
				}
			}
			sendShellStreamEvent(h2Request, execMsg, {
				case: "exit",
				value: create(ShellStreamExitSchema, {
					code: value.exitCode,
					cwd: value.workingDirectory,
					aborted: false,
				}),
			});
			return;
		}
		case "failure": {
			const value = result.value;
			if (sendBufferedOutput) {
				if (value.stdout) {
					sendShellStreamEvent(h2Request, execMsg, {
						case: "stdout",
						value: create(ShellStreamStdoutSchema, { data: sanitizeSurrogates(value.stdout) }),
					});
				}
				if (value.stderr) {
					sendShellStreamEvent(h2Request, execMsg, {
						case: "stderr",
						value: create(ShellStreamStderrSchema, { data: sanitizeSurrogates(value.stderr) }),
					});
				}
			}
			sendShellStreamEvent(h2Request, execMsg, {
				case: "exit",
				value: create(ShellStreamExitSchema, {
					code: value.exitCode,
					cwd: value.workingDirectory,
					aborted: value.aborted,
					abortReason: value.abortReason,
				}),
			});
			return;
		}
		case "rejected": {
			sendShellStreamEvent(h2Request, execMsg, { case: "rejected", value: result.value });
			sendShellStreamEvent(h2Request, execMsg, {
				case: "exit",
				value: create(ShellStreamExitSchema, {
					code: 1,
					cwd: result.value.workingDirectory,
					aborted: false,
				}),
			});
			return;
		}
		case "timeout": {
			const value = result.value;
			sendShellStreamEvent(h2Request, execMsg, {
				case: "stderr",
				value: create(ShellStreamStderrSchema, {
					data: `Command timed out after ${value.timeoutMs}ms`,
				}),
			});
			sendShellStreamEvent(h2Request, execMsg, {
				case: "exit",
				value: create(ShellStreamExitSchema, {
					code: 1,
					cwd: value.workingDirectory,
					aborted: true,
				}),
			});
			return;
		}
		case "permissionDenied": {
			sendShellStreamEvent(h2Request, execMsg, { case: "permissionDenied", value: result.value });
			sendShellStreamEvent(h2Request, execMsg, {
				case: "exit",
				value: create(ShellStreamExitSchema, {
					code: 1,
					cwd: result.value.workingDirectory,
					aborted: false,
				}),
			});
			return;
		}
		default:
			return;
	}
}

type ExecDispatchContext = {
	readonly execMsg: ExecServerMessage;
	readonly h2Request: http2.ClientHttp2Stream;
	readonly execHandlers: CursorExecHandlers | undefined;
	readonly onToolResult: CursorToolResultHandler | undefined;
	readonly requestContextTools: McpToolDefinition[];
	readonly output: AssistantMessage;
	readonly stream: AssistantMessageEventStream;
	readonly state: BlockState;
};

async function handleExecServerMessage(
	execMsg: ExecServerMessage,
	h2Request: http2.ClientHttp2Stream,
	execHandlers: CursorExecHandlers | undefined,
	onToolResult: CursorToolResultHandler | undefined,
	requestContextTools: McpToolDefinition[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: BlockState,
): Promise<void> {
	const execCase = execMsg.message.case;
	log("exec", "dispatch", { execCase, execId: execMsg.execId, hasHandlers: !!execHandlers });
	if (!execCase) {
		// A frame carrying a oneof number this build's `agent.proto` does not
		// model at all. Returning silently strands the exec id — the server
		// waits on a reply that never comes.
		log("warn", "unknownExecVariant", { id: execMsg.id, execId: execMsg.execId });
		sendExecClientThrow(h2Request, execMsg, "Unknown exec message variant", "unknown_exec_variant");
		sendExecClientStreamClose(h2Request, execMsg);
		return;
	}

	const stopExecHeartbeat = armCursorExecHeartbeat(h2Request, execMsg);
	try {
		await dispatchExecServerMessage({
			execMsg,
			h2Request,
			execHandlers,
			onToolResult,
			requestContextTools,
			output,
			stream,
			state,
		});
	} catch (error) {
		log("error", "execDispatch", {
			error: error instanceof Error ? error.message : String(error),
			id: execMsg.id,
			execId: execMsg.execId,
		});
		sendExecClientThrow(h2Request, execMsg, "Local exec dispatch failed", "exec_dispatch_failed");
	} finally {
		stopExecHeartbeat();
		sendExecClientStreamClose(h2Request, execMsg);
	}
}

async function dispatchExecServerMessage(context: ExecDispatchContext): Promise<void> {
	const { execMsg, h2Request, execHandlers, onToolResult, requestContextTools, output, stream, state } = context;
	const execCase = execMsg.message.case;
	if (!execCase) throw new Error("Expected a recognized exec message");
	if (execCase === "requestContextArgs") {
		const requestContext = create(RequestContextSchema, {
			rules: [],
			repositoryInfo: [],
			tools: requestContextTools,
			gitRepos: [],
			projectLayouts: [],
			mcpInstructions: [],
			fileContents: {},
			customSubagents: [],
		});

		const requestContextResult = create(RequestContextResultSchema, {
			result: {
				case: "success",
				value: create(RequestContextSuccessSchema, { requestContext }),
			},
		});

		sendExecClientMessage(h2Request, execMsg, "requestContextResult", requestContextResult);
		return;
	}

	switch (execCase) {
		case "readArgs": {
			const args = execMsg.message.value;
			if (!args.toolCallId) args.toolCallId = randomUUID();
			synthesizeCursorExecToolCall(output, stream, state, args.toolCallId, "read", {
				path: args.path,
				offset: args.offset,
				limit: args.limit,
			});
			const { execResult } = await resolveExecHandler(
				args,
				execHandlers?.read?.bind(execHandlers),
				onToolResult,
				(toolResult) =>
					buildReadResultFromToolResult(
						args.path,
						toolResult,
						args.offset !== undefined || args.limit !== undefined,
					),
				(reason) => buildReadRejectedResult(args.path, reason),
				(error) => buildReadErrorResult(args.path, error),
				{ toolCallId: args.toolCallId, toolName: "read" },
			);
			sendExecClientMessage(h2Request, execMsg, "readResult", execResult);
			return;
		}
		case "lsArgs": {
			const args = execMsg.message.value;
			if (!args.toolCallId) args.toolCallId = randomUUID();
			// The bridge maps `ls` onto the local `ls` tool; mirror that here so
			// the synthesized block matches the toolResult's `toolName`.
			synthesizeCursorExecToolCall(output, stream, state, args.toolCallId, "ls", { path: piLsPath(args.path) });
			const { execResult } = await resolveExecHandler(
				args,
				execHandlers?.ls?.bind(execHandlers),
				onToolResult,
				(toolResult) => buildLsResultFromToolResult(args.path, toolResult),
				(reason) => buildLsRejectedResult(args.path, reason),
				(error) => buildLsErrorResult(args.path, error),
				{ toolCallId: args.toolCallId, toolName: "ls" },
			);
			sendExecClientMessage(h2Request, execMsg, "lsResult", execResult);
			return;
		}
		case "grepArgs": {
			const args = execMsg.message.value;
			if (!args.toolCallId) args.toolCallId = randomUUID();
			// Cursor's model sometimes emits `grepArgs` with an empty `pattern`
			// and a non-empty `glob`, expecting grep to list files matching the
			// glob. Reject that up front with an actionable error.
			const emptyPatternError = emptyGrepPatternRejection(args.pattern, args.glob);
			if (emptyPatternError !== null) {
				sendExecClientMessage(h2Request, execMsg, "grepResult", buildGrepErrorResult(emptyPatternError));
				return;
			}
			// Mirror the coding-agent bridge's arg mapping so live UI (from
			// `tool_execution_start`) and rebuilt transcript display identical args.
			synthesizeCursorExecToolCall(output, stream, state, args.toolCallId, "grep", {
				pattern: args.pattern,
				path: args.path || undefined,
				glob: args.glob || undefined,
				ignoreCase: args.caseInsensitive === true ? true : undefined,
			});
			const { execResult } = await resolveExecHandler(
				args,
				execHandlers?.grep?.bind(execHandlers),
				onToolResult,
				(toolResult) => buildGrepResultFromToolResult(args, toolResult),
				(reason) => buildGrepErrorResult(reason),
				(error) => buildGrepErrorResult(error),
				{ toolCallId: args.toolCallId, toolName: "grep" },
			);
			sendExecClientMessage(h2Request, execMsg, "grepResult", execResult);
			return;
		}
		case "writeArgs": {
			const args = execMsg.message.value;
			if (!args.toolCallId) args.toolCallId = randomUUID();
			// Match the bridge: prefer `fileText`, fall back to decoded `fileBytes`.
			const content = args.fileText ?? new TextDecoder().decode(args.fileBytes ?? new Uint8Array());
			synthesizeCursorExecToolCall(output, stream, state, args.toolCallId, "write", {
				path: args.path,
				content,
			});
			const { execResult } = await resolveExecHandler(
				args,
				execHandlers?.write?.bind(execHandlers),
				onToolResult,
				(toolResult) =>
					buildWriteResultFromToolResult(
						{
							path: args.path,
							fileText: args.fileText,
							fileBytes: args.fileBytes,
							returnFileContentAfterWrite: args.returnFileContentAfterWrite,
						},
						toolResult,
					),
				(reason) => buildWriteRejectedResult(args.path, reason),
				(error) => buildWriteErrorResult(args.path, error),
				{ toolCallId: args.toolCallId, toolName: "write" },
			);
			sendExecClientMessage(h2Request, execMsg, "writeResult", execResult);
			return;
		}
		case "deleteArgs": {
			const args = execMsg.message.value;
			if (!args.toolCallId) args.toolCallId = randomUUID();
			synthesizeCursorExecToolCall(output, stream, state, args.toolCallId, "delete", { path: args.path });
			const { execResult } = await resolveExecHandler(
				args,
				execHandlers?.delete?.bind(execHandlers),
				onToolResult,
				(toolResult) => buildDeleteResultFromToolResult(args.path, toolResult),
				(reason) => buildDeleteRejectedResult(args.path, reason),
				(error) => buildDeleteErrorResult(args.path, error),
				{ toolCallId: args.toolCallId, toolName: "delete" },
			);
			sendExecClientMessage(h2Request, execMsg, "deleteResult", execResult);
			return;
		}
		case "shellArgs": {
			const args = execMsg.message.value;
			if (!args.toolCallId) args.toolCallId = randomUUID();
			const normalizedArgs: ShellArgs = { ...args, workingDirectory: args.workingDirectory || process.cwd() };
			const shellTimeout = args.timeout && args.timeout > 0 ? args.timeout : undefined;
			synthesizeCursorExecToolCall(output, stream, state, args.toolCallId, "bash", {
				command: composeShellCommand(args.command, args.workingDirectory || undefined),
				timeout: shellTimeout,
			});
			const { execResult } = await resolveExecHandler(
				normalizedArgs,
				execHandlers?.shell?.bind(execHandlers),
				onToolResult,
				(toolResult) => buildShellResultFromToolResult(normalizedArgs, toolResult),
				(reason) => buildShellRejectedResult(normalizedArgs.command, normalizedArgs.workingDirectory, reason),
				(error) => buildShellFailureResult(normalizedArgs.command, normalizedArgs.workingDirectory, error),
				{ toolCallId: args.toolCallId, toolName: "bash" },
			);
			sendExecClientMessage(h2Request, execMsg, "shellResult", sanitizeShellExecResult(execResult));
			return;
		}
		case "shellStreamArgs": {
			const args = execMsg.message.value;
			if (!args.toolCallId) args.toolCallId = randomUUID();
			const shellStreamTimeout = args.timeout && args.timeout > 0 ? args.timeout : undefined;
			synthesizeCursorExecToolCall(output, stream, state, args.toolCallId, "bash", {
				command: composeShellCommand(args.command, args.workingDirectory || undefined),
				timeout: shellStreamTimeout,
			});
			await handleShellStreamArgs(args, execMsg, h2Request, execHandlers, onToolResult);
			return;
		}
		case "backgroundShellSpawnArgs": {
			const args = execMsg.message.value;
			const execResult = create(BackgroundShellSpawnResultSchema, {
				result: {
					case: "rejected",
					value: create(ShellRejectedSchema, {
						command: args.command,
						workingDirectory: args.workingDirectory,
						reason: "Not implemented",
						isReadonly: false,
					}),
				},
			});
			sendExecClientMessage(h2Request, execMsg, "backgroundShellSpawnResult", execResult);
			return;
		}
		case "writeShellStdinArgs": {
			const execResult = create(WriteShellStdinResultSchema, {
				result: {
					case: "error",
					value: create(WriteShellStdinErrorSchema, {
						error: "Not implemented",
					}),
				},
			});
			sendExecClientMessage(h2Request, execMsg, "writeShellStdinResult", execResult);
			return;
		}
		case "fetchArgs": {
			const args = execMsg.message.value;
			const execResult = create(FetchResultSchema, {
				result: {
					case: "error",
					value: create(FetchErrorSchema, {
						url: args.url,
						error: "Not implemented",
					}),
				},
			});
			sendExecClientMessage(h2Request, execMsg, "fetchResult", execResult);
			return;
		}
		case "diagnosticsArgs": {
			const args = execMsg.message.value;
			if (!args.toolCallId) args.toolCallId = randomUUID();
			const { execResult } = await resolveExecHandler(
				args,
				execHandlers?.diagnostics?.bind(execHandlers),
				onToolResult,
				(toolResult) => buildDiagnosticsResultFromToolResult(args.path, toolResult),
				(reason) => buildDiagnosticsRejectedResult(args.path, reason),
				(error) => buildDiagnosticsErrorResult(args.path, error),
				// senpi has no local diagnostics tool; the frame is answered with a
				// refusal and no block is synthesized (nothing ran).
				null,
			);
			sendExecClientMessage(h2Request, execMsg, "diagnosticsResult", execResult);
			return;
		}
		case "mcpArgs": {
			const args = execMsg.message.value;
			const mcpCall = decodeMcpCall(args);
			// An approval probe, not an invocation: the frame asks whether the
			// call would be permitted. Only a definite allow is approved; without
			// a handler there is nothing to decide with, so it is refused. Either
			// way no block is synthesized — nothing ran.
			if (mcpCall.approvalOnly) {
				const approved = (await execHandlers?.mcpApprovalPreflight?.(mcpCall)) === true;
				sendExecClientMessage(
					h2Request,
					execMsg,
					"mcpResult",
					create(McpResultSchema, {
						result: approved
							? { case: "approved", value: create(McpApprovedSchema, {}) }
							: {
									case: "rejected",
									value: create(McpRejectedSchema, {
										reason: `Tool "${mcpCall.toolName || mcpCall.name}" is not approved to run without asking.`,
									}),
								},
					}),
				);
				return;
			}
			if (execHandlers?.mcp) {
				const existingBlock = output.content.find(
					(block) => block.type === "toolCall" && block.id === mcpCall.toolCallId,
				);
				if (existingBlock) {
					markCursorExecResolved(existingBlock);
				} else {
					synthesizeCursorExecToolCall(
						output,
						stream,
						state,
						mcpCall.toolCallId,
						mcpCall.toolName || mcpCall.name,
						mcpCall.args,
					);
					state.resolvedMcpToolCallIds.add(mcpCall.toolCallId);
				}
			}
			const { execResult } = await resolveExecHandler(
				mcpCall,
				execHandlers?.mcp?.bind(execHandlers),
				onToolResult,
				(toolResult) => buildMcpResultFromToolResult(mcpCall, toolResult),
				(_reason) => buildMcpToolNotFoundResult(mcpCall),
				(error) => buildMcpErrorResult(error),
				execHandlers?.mcp ? { toolCallId: mcpCall.toolCallId, toolName: mcpCall.toolName } : null,
			);
			sendExecClientMessage(h2Request, execMsg, "mcpResult", execResult);
			return;
		}
		case "listMcpResourcesExecArgs": {
			// This client hosts no MCP resources; the honest answer is an explicit
			// empty success. An unset-oneof result would read as "the call
			// produced nothing".
			const execResult = create(ListMcpResourcesExecResultSchema, {
				result: {
					case: "success",
					value: create(ListMcpResourcesSuccessSchema, { resources: [] }),
				},
			});
			sendExecClientMessage(h2Request, execMsg, "listMcpResourcesExecResult", execResult);
			return;
		}
		case "readMcpResourceExecArgs": {
			const args = execMsg.message.value;
			const execResult = create(ReadMcpResourceExecResultSchema, {
				result: { case: "notFound", value: create(ReadMcpResourceNotFoundSchema, { uri: args.uri }) },
			});
			sendExecClientMessage(h2Request, execMsg, "readMcpResourceExecResult", execResult);
			return;
		}
		case "recordScreenArgs": {
			const execResult = create(RecordScreenResultSchema, {
				result: { case: "failure", value: create(RecordScreenFailureSchema, { error: NOT_IMPLEMENTED }) },
			});
			sendExecClientMessage(h2Request, execMsg, "recordScreenResult", execResult);
			return;
		}
		case "computerUseArgs": {
			const execResult = create(ComputerUseResultSchema, {
				result: { case: "error", value: create(ComputerUseErrorSchema, { error: NOT_IMPLEMENTED }) },
			});
			sendExecClientMessage(h2Request, execMsg, "computerUseResult", execResult);
			return;
		}
		case "piReadArgs": {
			const args = execMsg.message.value;
			const toolCallId = randomUUID();
			const readArgs = piReadArgs(args.path, args.offset, args.limit);
			synthesizeCursorExecToolCall(
				output,
				stream,
				state,
				toolCallId,
				"read",
				readArgs ?? { path: args.path, offset: args.offset, limit: 0 },
			);
			const { execResult } = await resolveExecHandler(
				{ args, toolCallId },
				execHandlers?.piRead?.bind(execHandlers),
				onToolResult,
				buildPiReadResult,
				buildPiReadError,
				buildPiReadError,
				{ toolCallId, toolName: "read" },
			);
			sendExecClientMessage(h2Request, execMsg, "piReadResult", execResult);
			return;
		}
		case "piBashArgs": {
			const args = execMsg.message.value;
			const toolCallId = randomUUID();
			synthesizeCursorExecToolCall(output, stream, state, toolCallId, "bash", {
				command: args.command,
				timeout: piTimeout(args.timeout),
			});
			const { execResult } = await resolveExecHandler(
				{ args, toolCallId },
				execHandlers?.piBash?.bind(execHandlers),
				onToolResult,
				buildPiBashResult,
				buildPiBashError,
				buildPiBashError,
				{ toolCallId, toolName: "bash" },
			);
			sendExecClientMessage(h2Request, execMsg, "piBashResult", execResult);
			return;
		}
		case "piEditArgs": {
			const args = execMsg.message.value;
			const toolCallId = randomUUID();
			// `PiEditReplacement[]` maps 1:1 onto the local `edit` tool's
			// `edits[{oldText,newText}]` shape.
			synthesizeCursorExecToolCall(output, stream, state, toolCallId, "edit", {
				path: args.path,
				edits: args.edits.map((edit) => ({ oldText: edit.oldText, newText: edit.newText })),
			});
			const { execResult } = await resolveExecHandler(
				{ args, toolCallId },
				execHandlers?.piEdit?.bind(execHandlers),
				onToolResult,
				buildPiEditResult,
				buildPiEditRejected,
				buildPiEditError,
				{ toolCallId, toolName: "edit" },
			);
			sendExecClientMessage(h2Request, execMsg, "piEditResult", execResult);
			return;
		}
		case "piWriteArgs": {
			const args = execMsg.message.value;
			const toolCallId = randomUUID();
			synthesizeCursorExecToolCall(output, stream, state, toolCallId, "write", {
				path: args.path,
				content: args.content,
			});
			const { execResult } = await resolveExecHandler(
				{ args, toolCallId },
				execHandlers?.piWrite?.bind(execHandlers),
				onToolResult,
				buildPiWriteResult,
				buildPiWriteRejected,
				buildPiWriteError,
				{ toolCallId, toolName: "write" },
			);
			sendExecClientMessage(h2Request, execMsg, "piWriteResult", execResult);
			return;
		}
		case "piGrepArgs": {
			const args = execMsg.message.value;
			const toolCallId = randomUUID();
			synthesizeCursorExecToolCall(output, stream, state, toolCallId, "grep", {
				pattern: args.pattern,
				path: args.path || undefined,
				glob: args.glob || undefined,
				ignoreCase: args.ignoreCase === true ? true : undefined,
				literal: args.literal === true ? true : undefined,
				context: args.context,
				limit: piLimit(args.limit),
			});
			const { execResult } = await resolveExecHandler(
				{ args, toolCallId },
				execHandlers?.piGrep?.bind(execHandlers),
				onToolResult,
				buildPiGrepResult,
				buildPiGrepError,
				buildPiGrepError,
				{ toolCallId, toolName: "grep" },
			);
			sendExecClientMessage(h2Request, execMsg, "piGrepResult", execResult);
			return;
		}
		case "piFindArgs": {
			const args = execMsg.message.value;
			const toolCallId = randomUUID();
			synthesizeCursorExecToolCall(output, stream, state, toolCallId, "find", {
				pattern: args.pattern,
				path: args.path || undefined,
				limit: piLimit(args.limit),
			});
			const { execResult } = await resolveExecHandler(
				{ args, toolCallId },
				execHandlers?.piFind?.bind(execHandlers),
				onToolResult,
				buildPiFindResult,
				buildPiFindError,
				buildPiFindError,
				{ toolCallId, toolName: "find" },
			);
			sendExecClientMessage(h2Request, execMsg, "piFindResult", execResult);
			return;
		}
		case "piLsArgs": {
			const args = execMsg.message.value;
			const toolCallId = randomUUID();
			synthesizeCursorExecToolCall(output, stream, state, toolCallId, "ls", {
				path: piLsPath(args.path),
				limit: piLimit(args.limit),
			});
			const { execResult } = await resolveExecHandler(
				{ args, toolCallId },
				execHandlers?.piLs?.bind(execHandlers),
				onToolResult,
				buildPiLsResult,
				buildPiLsError,
				buildPiLsError,
				{ toolCallId, toolName: "ls" },
			);
			sendExecClientMessage(h2Request, execMsg, "piLsResult", execResult);
			return;
		}
		case "miniSweAgentBashArgs": {
			// Same `ShellArgs`/`ShellResult` pair as `shellArgs`, under its own
			// frame number, so the existing shell handler answers it unchanged.
			const args = execMsg.message.value;
			if (!args.toolCallId) args.toolCallId = randomUUID();
			const normalizedArgs: ShellArgs = { ...args, workingDirectory: args.workingDirectory || process.cwd() };
			synthesizeCursorExecToolCall(output, stream, state, args.toolCallId, "bash", {
				command: composeShellCommand(args.command, args.workingDirectory || undefined),
				timeout: args.timeout && args.timeout > 0 ? args.timeout : undefined,
			});
			const { execResult } = await resolveExecHandler(
				normalizedArgs,
				execHandlers?.shell?.bind(execHandlers),
				onToolResult,
				(toolResult) => buildShellResultFromToolResult(normalizedArgs, toolResult),
				(reason) => buildShellRejectedResult(normalizedArgs.command, normalizedArgs.workingDirectory, reason),
				(error) => buildShellFailureResult(normalizedArgs.command, normalizedArgs.workingDirectory, error),
				{ toolCallId: args.toolCallId, toolName: "bash" },
			);
			sendExecClientMessage(h2Request, execMsg, "miniSweAgentBashResult", sanitizeShellExecResult(execResult));
			return;
		}
		case "redactedReadArgs": {
			// The server expects the client to strip secrets from the content
			// first. No redaction is implemented here, and serving a plain read
			// would hand back exactly the unredacted bytes the frame exists to
			// withhold.
			const args = execMsg.message.value;
			sendExecClientMessage(
				h2Request,
				execMsg,
				"redactedReadResult",
				buildReadErrorResult(args.path, "Secret redaction is not implemented by this client"),
			);
			return;
		}
		case "mcpStateExecArgs": {
			const args = execMsg.message.value;
			sendExecClientMessage(
				h2Request,
				execMsg,
				"mcpStateExecResult",
				buildMcpStateResult(requestContextTools, args.serverIdentifiers),
			);
			return;
		}
		case "executeHookArgs": {
			const args = execMsg.message.value;
			const execResult = buildNeutralHookResult(args.request);
			if (!execResult) {
				sendExecClientThrow(
					h2Request,
					execMsg,
					`Unsupported hook request: ${args.request?.request.case ?? "unset"}`,
					"unknown_hook_request",
				);
				return;
			}
			sendExecClientMessage(h2Request, execMsg, "executeHookResult", execResult);
			return;
		}
		case "subagentArgs": {
			const execResult = create(SubagentResultSchema, {
				result: {
					case: "error",
					value: create(SubagentErrorSchema, { error: `Subagents are ${NOT_IMPLEMENTED_SUFFIX}` }),
				},
			});
			sendExecClientMessage(h2Request, execMsg, "subagentResult", execResult);
			return;
		}
		case "subagentAwaitArgs": {
			// No subagent was ever spawned, so every awaited id is genuinely unknown.
			const args = execMsg.message.value;
			const execResult = create(SubagentAwaitResultSchema, {
				result: {
					case: "notFound",
					value: create(SubagentAwaitNotFoundSchema, { agentId: args.agentId }),
				},
			});
			sendExecClientMessage(h2Request, execMsg, "subagentAwaitResult", execResult);
			return;
		}
		case "forceBackgroundShellArgs": {
			// Backgrounding targets a running tool call by id. This client runs
			// every shell to completion in band, so there is never one to move.
			const execResult = create(ForceBackgroundShellResultSchema, {
				status: ForceBackgroundShellStatus.NOT_FOUND,
			});
			sendExecClientMessage(h2Request, execMsg, "forceBackgroundShellResult", execResult);
			return;
		}
		case "forceBackgroundSubagentArgs": {
			const execResult = create(ForceBackgroundSubagentResultSchema, {
				status: ForceBackgroundSubagentStatus.NOT_FOUND,
			});
			sendExecClientMessage(h2Request, execMsg, "forceBackgroundSubagentResult", execResult);
			return;
		}
		case "smartModeClassifierArgs": {
			// The classifier decides whether a risky action needs approval.
			// Answering `ALLOW` would silently wave through actions the server
			// asked us to judge, so the honest answer is that no classifier
			// exists here.
			const execResult = create(SmartModeClassifierResultSchema, {
				result: {
					case: "error",
					value: create(SmartModeClassifierErrorSchema, {
						error: `Smart-mode classification is ${NOT_IMPLEMENTED_SUFFIX}`,
					}),
				},
			});
			sendExecClientMessage(h2Request, execMsg, "smartModeClassifierResult", execResult);
			return;
		}
		case "canvasDiagnosticsArgs": {
			const args = execMsg.message.value;
			const execResult = create(CanvasDiagnosticsResultSchema, {
				result: {
					case: "error",
					value: create(CanvasDiagnosticsErrorSchema, {
						path: args.path,
						error: `Canvas diagnostics are ${NOT_IMPLEMENTED_SUFFIX}`,
					}),
				},
			});
			sendExecClientMessage(h2Request, execMsg, "canvasDiagnosticsResult", execResult);
			return;
		}
		case "shellAllowlistPrecheckArgs": {
			// The prechecks ask "is this pre-approved, so may it skip the approval
			// prompt?". This client keeps no allowlist, so the answer is always
			// no: `false` costs an approval round-trip, `true` would grant one
			// that was never configured.
			sendExecClientMessage(
				h2Request,
				execMsg,
				"shellAllowlistPrecheckResult",
				create(ShellAllowlistPrecheckResultSchema, { allowlisted: false }),
			);
			return;
		}
		case "mcpAllowlistPrecheckArgs": {
			sendExecClientMessage(
				h2Request,
				execMsg,
				"mcpAllowlistPrecheckResult",
				create(McpAllowlistPrecheckResultSchema, { allowlisted: false }),
			);
			return;
		}
		case "webFetchAllowlistPrecheckArgs": {
			sendExecClientMessage(
				h2Request,
				execMsg,
				"webFetchAllowlistPrecheckResult",
				create(WebFetchAllowlistPrecheckResultSchema, { allowlisted: false }),
			);
			return;
		}
		case "conversationSearchArgs": {
			// Cursor conversation history lives server-side; this client keeps no
			// local index of it to search. The streamed envelope announces this
			// call but the interaction decoder builds no block for it, so the
			// block and its paired result are synthesized here.
			const args = execMsg.message.value;
			const toolCallId = args.toolCallId || randomUUID();
			const error = `Conversation search is ${NOT_IMPLEMENTED_SUFFIX}`;
			synthesizeCursorExecToolCall(output, stream, state, toolCallId, "search_conversations", {
				query: args.query,
				limit: args.limit,
			});
			await pairSynthesizedExecResult(state, onToolResult, toolCallId, "search_conversations", error);
			const execResult = create(ConversationSearchResultSchema, {
				result: { case: "error", value: create(ConversationSearchErrorSchema, { error }) },
			});
			sendExecClientMessage(h2Request, execMsg, "conversationSearchResult", execResult);
			return;
		}
		case "agentStoreConflictArgs": {
			// The agent store is Cursor's own on-disk journal; this client never
			// writes one, so it has no conflict events to replay.
			const execResult = create(AgentStoreConflictResultSchema, {
				result: {
					case: "error",
					value: create(AgentStoreConflictErrorSchema, {
						error: `Agent store conflicts are ${NOT_IMPLEMENTED_SUFFIX}`,
					}),
				},
			});
			sendExecClientMessage(h2Request, execMsg, "agentStoreConflictResult", execResult);
			return;
		}
		case "gitDiffRequest": {
			// `GetDiffResponse` has no error variant, so any in-band answer is a
			// claim that a diff was computed; a `throw` is the only truthful reply.
			sendExecClientThrow(h2Request, execMsg, `Git diff is ${NOT_IMPLEMENTED_SUFFIX}`, "exec_variant_unsupported");
			return;
		}
		default: {
			// A frame number this build recognises structurally but has no answer
			// for. Distinct from the unset-case path above: there the client
			// cannot even name the frame.
			log("warn", "unhandledExecMessage", { execCase });
			sendExecClientThrow(
				h2Request,
				execMsg,
				`No handler for exec message of type ${execCase}`,
				"exec_variant_unsupported",
			);
		}
	}
}

function armCursorExecHeartbeat(h2Request: http2.ClientHttp2Stream, execMsg: ExecServerMessage): () => void {
	return armExecHeartbeat({
		intervalMs: EXEC_HEARTBEAT_INTERVAL_MS,
		isClosed: () => h2Request.closed,
		writeHeartbeat: (onComplete) => {
			const controlMessage = create(ExecClientControlMessageSchema, {
				message: {
					case: "heartbeat",
					value: create(ExecClientHeartbeatSchema, { id: execMsg.id }),
				},
			});
			const clientMessage = create(AgentClientMessageSchema, {
				message: { case: "execClientControlMessage", value: controlMessage },
			});
			h2Request.write(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)), onComplete);
			log("execClientControl", "heartbeat", { id: execMsg.id, execId: execMsg.execId });
		},
	});
}

/**
 * Send one typed answer on the exec channel.
 *
 * `ExecClientMessage["message"]` is a discriminated union pairing each case
 * with its own result type, so the generic is keyed on the case: passing a
 * `ReadResult` under `"shellResult"` is a compile error rather than a wire
 * message the server rejects at runtime.
 */
function sendExecClientMessage<TCase extends NonNullable<ExecClientMessage["message"]["case"]>>(
	h2Request: http2.ClientHttp2Stream,
	execMsg: ExecServerMessage,
	messageCase: TCase,
	value: Extract<ExecClientMessage["message"], { case: TCase }>["value"],
): void {
	const execClientMessage = create(ExecClientMessageSchema, {
		id: execMsg.id,
		execId: execMsg.execId,
		message: { case: messageCase, value } as ExecClientMessage["message"],
	});

	const clientMessage = create(AgentClientMessageSchema, {
		message: { case: "execClientMessage", value: execClientMessage },
	});

	h2Request.write(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)));

	log("execClientMessage", messageCase);
}

/**
 * Fail one exec frame in band.
 *
 * `ExecClientThrow` is the protocol's failure channel for a frame that cannot
 * be answered at all — as opposed to a frame answered with its own typed
 * error variant, which means "the tool ran and failed". The server surfaces
 * the error to the model instead of blocking on a reply that never comes.
 */
function sendExecClientThrow(
	h2Request: http2.ClientHttp2Stream,
	execMsg: ExecServerMessage,
	error: string,
	errorCode?: string,
): void {
	const controlMessage = create(ExecClientControlMessageSchema, {
		message: {
			case: "throw",
			value: create(ExecClientThrowSchema, { id: execMsg.id, error, errorCode }),
		},
	});
	const clientMessage = create(AgentClientMessageSchema, {
		message: { case: "execClientControlMessage", value: controlMessage },
	});
	h2Request.write(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)));
	log("execClientControl", "throw", { id: execMsg.id, execId: execMsg.execId, error, errorCode });
}

function sendExecClientStreamClose(h2Request: http2.ClientHttp2Stream, execMsg: ExecServerMessage): void {
	const closeMessage = create(ExecClientControlMessageSchema, {
		message: {
			case: "streamClose",
			value: create(ExecClientStreamCloseSchema, {
				id: execMsg.id,
			}),
		},
	});
	const clientMessage = create(AgentClientMessageSchema, {
		message: { case: "execClientControlMessage", value: closeMessage },
	});
	h2Request.write(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)));
	log("execClientControl", "streamClose", { id: execMsg.id, execId: execMsg.execId });
}

/**
 * Exported for tests: dispatches one exec frame onto its handler.
 *
 * Every exit pairs a `toolResult`. The synthesized block was already marked
 * `kCursorExecResolved` before this runs, so the agent loop emits no
 * placeholder for it: a path that returns without a result leaves the call
 * unpaired and transcript rebuilds strip the whole interaction. The three
 * result-less paths — no handler installed, a handler that produced nothing,
 * and a thrown handler — therefore synthesize one from the same text the
 * server sees in `execResult`.
 *
 * `pairing` is required so a new callsite cannot silently recreate the
 * orphan, and nullable for the callers whose block is NOT pre-resolved (MCP
 * without an `mcp` handler, which the agent loop runs locally and pairs
 * itself, and frames that never synthesize a block).
 */
export async function resolveExecHandler<TArgs, TResult>(
	args: TArgs,
	handler: ((args: TArgs) => Promise<CursorExecHandlerResult<TResult>>) | undefined,
	onToolResult: CursorToolResultHandler | undefined,
	buildFromToolResult: (toolResult: ToolResultMessage) => TResult,
	buildRejected: (reason: string) => TResult,
	buildError: (error: string) => TResult,
	pairing: CursorExecPairing | null,
): Promise<{ execResult: TResult; toolResult?: ToolResultMessage }> {
	const pair = async (text: string, isError: boolean): Promise<ToolResultMessage | undefined> => {
		if (!pairing) return undefined;
		const synthesized: ToolResultMessage = {
			role: "toolResult",
			toolCallId: pairing.toolCallId,
			toolName: pairing.toolName,
			content: [{ type: "text", text }],
			isError,
			timestamp: Date.now(),
		};
		return await applyToolResultHandler(synthesized, onToolResult);
	};

	if (!handler) {
		const reason = "Tool not available";
		return { execResult: buildRejected(reason), toolResult: await pair(reason, true) };
	}

	try {
		const handlerResult = await handler(args);
		const { execResult, toolResult } = splitExecHandlerResult(handlerResult);
		const finalToolResult = await applyToolResultHandler(toolResult, onToolResult);

		if (execResult) {
			// TResult-only is a supported return form, so the transcript entry
			// has to be synthesized here, derived from the raw result so the two
			// views stay consistent.
			return {
				execResult,
				toolResult: finalToolResult ?? (await pair(...describeExecResult(execResult))),
			};
		}
		if (finalToolResult) {
			return { execResult: buildFromToolResult(finalToolResult), toolResult: finalToolResult };
		}
		const reason = "Tool returned no result";
		return { execResult: buildRejected(reason), toolResult: await pair(reason, true) };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { execResult: buildError(message), toolResult: await pair(message, true) };
	}
}

/**
 * Derive the transcript state of an exec result the handler returned in the
 * TResult-only form, which carries no `toolResult` to copy it from.
 *
 * Every exec result in `agent.proto` is a `oneof result` whose success
 * variant is named `success` — the rest are failures. MCP is the one shape
 * where `success` is not enough: `McpSuccess.is_error` carries an
 * application-level tool failure inside the success variant.
 */
function describeExecResult(execResult: unknown): [text: string, isError: boolean] {
	const result = (execResult as { result?: { case?: string; value?: unknown } } | null)?.result;
	const variant = result?.case;
	if (variant === "success") {
		const success = result?.value as { isError?: boolean; content?: unknown[] } | undefined;
		if (!success?.isError) return ["Tool produced no transcript result", false];
		return [mcpContentToText(success.content) || "MCP tool reported an error", true];
	}
	if (!variant) return ["Tool produced no transcript result", false];
	const value = result?.value as { error?: string; reason?: string } | undefined;
	return [value?.error || value?.reason || `Tool call ${variant}`, true];
}

/** Flatten `McpSuccess.content` into transcript text. */
function mcpContentToText(content: unknown[] | undefined): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const item of content) {
		const inner = (item as { content?: { case?: string; value?: { text?: string } } } | null)?.content;
		if (inner?.case === "text" && inner.value?.text) parts.push(inner.value.text);
	}
	return parts.join("\n");
}

function splitExecHandlerResult<TResult>(result: CursorExecHandlerResult<TResult>): {
	execResult?: TResult;
	toolResult?: ToolResultMessage;
} {
	if (isToolResultMessage(result)) {
		return { toolResult: result };
	}
	if (result && typeof result === "object") {
		const record = result as Record<string, unknown>;
		if ("execResult" in record) {
			const { execResult, toolResult } = record as {
				execResult: TResult;
				toolResult?: ToolResultMessage;
			};
			return { execResult, toolResult };
		}
		if ("toolResult" in record && !isToolResultMessage(record)) {
			const { result: execResult, toolResult } = record as {
				result?: TResult;
				toolResult?: ToolResultMessage;
			};
			return { execResult, toolResult };
		}
		if ("result" in record && !("$typeName" in record)) {
			const { result: execResult, toolResult } = record as {
				result: TResult;
				toolResult?: ToolResultMessage;
			};
			return { execResult, toolResult };
		}
	}
	return { execResult: result as TResult };
}

function isToolResultMessage(value: unknown): value is ToolResultMessage {
	return !!value && typeof value === "object" && (value as ToolResultMessage).role === "toolResult";
}

async function applyToolResultHandler(
	toolResult: ToolResultMessage | undefined,
	onToolResult: CursorToolResultHandler | undefined,
): Promise<ToolResultMessage | undefined> {
	if (!toolResult || !onToolResult) {
		return toolResult;
	}
	const updated = await onToolResult(toolResult);
	return updated ?? toolResult;
}

function toolResultToText(toolResult: ToolResultMessage): string {
	return toolResult.content.map((item) => (item.type === "text" ? item.text : `[${item.mimeType} image]`)).join("\n");
}

function toolResultWasTruncated(toolResult: ToolResultMessage): boolean {
	if (!toolResult.details || typeof toolResult.details !== "object") {
		return false;
	}
	const truncation = (toolResult.details as { truncation?: { truncated?: boolean } }).truncation;
	return !!truncation?.truncated;
}

function toolResultDetailBoolean(toolResult: ToolResultMessage, key: string): boolean {
	if (!toolResult.details || typeof toolResult.details !== "object") {
		return false;
	}
	const value = (toolResult.details as Record<string, unknown>)[key];
	return typeof value === "boolean" ? value : false;
}

/** The file's own line count, when the tool recorded one. */
function readTotalLinesFromDetails(toolResult: ToolResultMessage): number | undefined {
	const details = toolResult.details;
	if (!details || typeof details !== "object") return undefined;
	const direct = "totalLines" in details ? details.totalLines : undefined;
	if (typeof direct === "number" && Number.isFinite(direct)) return direct;
	const meta = "meta" in details ? details.meta : undefined;
	if (!meta || typeof meta !== "object") return undefined;
	const truncation = "truncation" in meta ? meta.truncation : undefined;
	if (!truncation || typeof truncation !== "object") return undefined;
	const totalLines = "totalLines" in truncation ? truncation.totalLines : undefined;
	return typeof totalLines === "number" && Number.isFinite(totalLines) ? totalLines : undefined;
}

function readFileSizeFromDetails(toolResult: ToolResultMessage): number | undefined {
	const details = toolResult.details;
	if (!details || typeof details !== "object" || !("fileSize" in details)) return undefined;
	const { fileSize } = details;
	return typeof fileSize === "number" && Number.isSafeInteger(fileSize) && fileSize >= 0 ? fileSize : undefined;
}

function buildReadResultFromToolResult(path: string, toolResult: ToolResultMessage, rangeApplied = false) {
	const text = toolResultToText(toolResult);
	if (toolResult.isError) {
		return buildReadErrorResult(path, text || "Read failed");
	}
	// Counting the payload is only the file's length when the payload is the
	// whole file: under a windowed read, answering a 20-line page of a 100-line
	// file with `total_lines: 20` tells a paginating server it reached the end.
	const totalLines = readTotalLinesFromDetails(toolResult) ?? (rangeApplied ? 0 : text ? text.split("\n").length : 0);
	return create(ReadResultSchema, {
		result: {
			case: "success",
			value: create(ReadSuccessSchema, {
				path,
				totalLines,
				fileSize: BigInt(readFileSizeFromDetails(toolResult) ?? Buffer.byteLength(text, "utf-8")),
				truncated: toolResultWasTruncated(toolResult),
				output: { case: "content", value: text },
				rangeApplied,
			}),
		},
	});
}

function buildReadErrorResult(path: string, error: string) {
	return create(ReadResultSchema, {
		result: {
			case: "error",
			value: create(ReadErrorSchema, { path, error }),
		},
	});
}

function buildReadRejectedResult(path: string, reason: string) {
	return create(ReadResultSchema, {
		result: {
			case: "rejected",
			value: create(ReadRejectedSchema, { path, reason }),
		},
	});
}

function buildWriteResultFromToolResult(
	args: { path: string; fileText?: string; fileBytes?: Uint8Array; returnFileContentAfterWrite?: boolean },
	toolResult: ToolResultMessage,
) {
	const text = toolResultToText(toolResult);
	if (toolResult.isError) {
		return buildWriteErrorResult(args.path, text || "Write failed");
	}
	const fileText = args.fileText ?? "";
	const fileSize = args.fileBytes?.length ?? Buffer.byteLength(fileText, "utf-8");
	const linesCreated = fileText ? fileText.split("\n").length : 0;
	return create(WriteResultSchema, {
		result: {
			case: "success",
			value: create(WriteSuccessSchema, {
				path: args.path,
				linesCreated,
				fileSize,
				fileContentAfterWrite: args.returnFileContentAfterWrite ? fileText : undefined,
			}),
		},
	});
}

function buildWriteErrorResult(path: string, error: string) {
	return create(WriteResultSchema, {
		result: {
			case: "error",
			value: create(WriteErrorSchema, { path, error }),
		},
	});
}

function buildWriteRejectedResult(path: string, reason: string) {
	return create(WriteResultSchema, {
		result: {
			case: "rejected",
			value: create(WriteRejectedSchema, { path, reason }),
		},
	});
}

function buildDeleteResultFromToolResult(path: string, toolResult: ToolResultMessage) {
	const text = toolResultToText(toolResult);
	if (toolResult.isError) {
		return buildDeleteErrorResult(path, text || "Delete failed");
	}
	return create(DeleteResultSchema, {
		result: {
			case: "success",
			value: create(DeleteSuccessSchema, {
				path,
				deletedFile: path,
				fileSize: BigInt(0),
				prevContent: "",
			}),
		},
	});
}

function buildDeleteErrorResult(path: string, error: string) {
	return create(DeleteResultSchema, {
		result: {
			case: "error",
			value: create(DeleteErrorSchema, { path, error }),
		},
	});
}

function buildDeleteRejectedResult(path: string, reason: string) {
	return create(DeleteResultSchema, {
		result: {
			case: "rejected",
			value: create(DeleteRejectedSchema, { path, reason }),
		},
	});
}

function buildShellResultFromToolResult(
	args: { command: string; workingDirectory: string },
	toolResult: ToolResultMessage,
) {
	const output = toolResultToText(toolResult);
	if (toolResult.isError) {
		return buildShellFailureResult(args.command, args.workingDirectory, output || "Shell failed");
	}
	return create(ShellResultSchema, {
		result: {
			case: "success",
			value: create(ShellSuccessSchema, {
				command: args.command,
				workingDirectory: args.workingDirectory,
				exitCode: 0,
				signal: "",
				stdout: output,
				stderr: "",
				executionTime: 0,
			}),
		},
	});
}

function buildShellFailureResult(command: string, workingDirectory: string, error: string) {
	return create(ShellResultSchema, {
		result: {
			case: "failure",
			value: create(ShellFailureSchema, {
				command,
				workingDirectory,
				exitCode: 1,
				signal: "",
				stdout: "",
				stderr: error,
				executionTime: 0,
				aborted: false,
			}),
		},
	});
}

function buildShellRejectedResult(command: string, workingDirectory: string, reason: string) {
	return create(ShellResultSchema, {
		result: {
			case: "rejected",
			value: create(ShellRejectedSchema, {
				command,
				workingDirectory,
				reason,
				isReadonly: false,
			}),
		},
	});
}

function buildLsResultFromToolResult(path: string, toolResult: ToolResultMessage) {
	const text = toolResultToText(toolResult);
	if (toolResult.isError) {
		return buildLsErrorResult(path, text || "Ls failed");
	}
	const rootPath = path || ".";
	const entries = text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("["));
	const childrenDirs: LsDirectoryTreeNode[] = [];
	const childrenFiles: LsDirectoryTreeNode_File[] = [];

	for (const entry of entries) {
		const name = entry.split(" (")[0];
		if (name.endsWith("/")) {
			const dirName = name.slice(0, -1);
			childrenDirs.push(
				create(LsDirectoryTreeNodeSchema, {
					absPath: `${rootPath.replace(/\/$/, "")}/${dirName}`,
					childrenDirs: [],
					childrenFiles: [],
					childrenWereProcessed: false,
					fullSubtreeExtensionCounts: {},
					numFiles: 0,
				}),
			);
		} else {
			childrenFiles.push(create(LsDirectoryTreeNode_FileSchema, { name }));
		}
	}

	const root = create(LsDirectoryTreeNodeSchema, {
		absPath: rootPath,
		childrenDirs,
		childrenFiles,
		childrenWereProcessed: true,
		fullSubtreeExtensionCounts: {},
		numFiles: childrenFiles.length,
	});

	return create(LsResultSchema, {
		result: {
			case: "success",
			value: create(LsSuccessSchema, { directoryTreeRoot: root }),
		},
	});
}

function buildLsErrorResult(path: string, error: string) {
	return create(LsResultSchema, {
		result: {
			case: "error",
			value: create(LsErrorSchema, { path, error }),
		},
	});
}

function buildLsRejectedResult(path: string, reason: string) {
	return create(LsResultSchema, {
		result: {
			case: "rejected",
			value: create(LsRejectedSchema, { path, reason }),
		},
	});
}

function buildGrepResultFromToolResult(
	args: { pattern: string; path?: string; outputMode?: string; offset?: number },
	toolResult: ToolResultMessage,
) {
	const text = toolResultToText(toolResult);
	if (toolResult.isError) {
		return buildGrepErrorResult(text || "Grep failed");
	}

	const outputMode = args.outputMode || "content";
	const clientTruncated = toolResultDetailBoolean(toolResult, "truncated");
	const lines = text
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0 && !line.startsWith("[") && !line.toLowerCase().startsWith("no matches"));

	const workspaceKey = args.path || ".";
	let unionResult: GrepUnionResult;

	if (outputMode === "files_with_matches") {
		const files = lines;
		unionResult = create(GrepUnionResultSchema, {
			result: {
				case: "files",
				value: create(GrepFilesResultSchema, {
					files,
					totalFiles: files.length,
					clientTruncated,
					ripgrepTruncated: false,
					offsetApplied: args.offset,
				}),
			},
		});
	} else if (outputMode === "count") {
		const counts = lines
			.map((line) => {
				const separatorIndex = line.lastIndexOf(":");
				if (separatorIndex === -1) {
					return null;
				}
				const file = line.slice(0, separatorIndex);
				const count = Number.parseInt(line.slice(separatorIndex + 1), 10);
				if (!file || Number.isNaN(count)) {
					return null;
				}
				return create(GrepFileCountSchema, { file, count });
			})
			.filter((entry): entry is GrepFileCount => entry !== null);
		const totalMatches = counts.reduce((sum, entry) => sum + entry.count, 0);
		unionResult = create(GrepUnionResultSchema, {
			result: {
				case: "count",
				value: create(GrepCountResultSchema, {
					counts,
					totalFiles: counts.length,
					totalMatches,
					clientTruncated,
					ripgrepTruncated: false,
					offsetApplied: args.offset,
				}),
			},
		});
	} else {
		const matchMap = new Map<string, Array<{ line: number; content: string; isContextLine: boolean }>>();
		let totalMatchedLines = 0;

		for (const line of lines) {
			const matchLine = line.match(/^(.+?):(\d+):\s?(.*)$/);
			const contextLine = line.match(/^(.+?)-(\d+)-\s?(.*)$/);
			const match = matchLine ?? contextLine;
			if (!match) {
				continue;
			}
			const [, file, lineNumber, content] = match;
			const isContextLine = Boolean(contextLine);
			const list = matchMap.get(file) ?? [];
			list.push({ line: Number(lineNumber), content, isContextLine });
			matchMap.set(file, list);
			if (!isContextLine) {
				totalMatchedLines += 1;
			}
		}

		const matches = Array.from(matchMap.entries()).map(([file, fileMatches]) =>
			create(GrepFileMatchSchema, {
				file,
				matches: fileMatches.map((entry) =>
					create(GrepContentMatchSchema, {
						lineNumber: entry.line,
						content: entry.content,
						contentTruncated: false,
						isContextLine: entry.isContextLine,
					}),
				),
			}),
		);
		const totalLines = matches.reduce((sum, entry) => sum + entry.matches.length, 0);
		unionResult = create(GrepUnionResultSchema, {
			result: {
				case: "content",
				value: create(GrepContentResultSchema, {
					matches,
					totalLines,
					totalMatchedLines,
					clientTruncated,
					ripgrepTruncated: false,
					offsetApplied: args.offset,
				}),
			},
		});
	}

	return create(GrepResultSchema, {
		result: {
			case: "success",
			value: create(GrepSuccessSchema, {
				pattern: args.pattern,
				path: args.path || "",
				outputMode,
				workspaceResults: { [workspaceKey]: unionResult },
			}),
		},
	});
}

function buildGrepErrorResult(error: string) {
	return create(GrepResultSchema, {
		result: {
			case: "error",
			value: create(GrepErrorSchema, { error }),
		},
	});
}

/**
 * Reject a Cursor exec-channel `grepArgs` frame whose `pattern` is empty or
 * whitespace-only. Returns an actionable error message (with a `glob`-aware
 * hint when the model likely meant to list files) or `null` when the pattern
 * is valid and grep should run. Exported for tests.
 */
export function emptyGrepPatternRejection(pattern: string | undefined, glob: string | undefined): string | null {
	if (pattern && pattern.trim().length > 0) return null;
	if (glob && glob.length > 0) {
		return (
			`grep pattern is required (received an empty pattern). To list files matching "${glob}", ` +
			`pass a non-empty regex (e.g. ".") and set path to that glob, or use the ls/read tool instead.`
		);
	}
	return "grep pattern is required (received an empty pattern).";
}

function buildDiagnosticsResultFromToolResult(path: string, toolResult: ToolResultMessage) {
	const text = toolResultToText(toolResult);
	if (toolResult.isError) {
		return buildDiagnosticsErrorResult(path, text || "Diagnostics failed");
	}
	return create(DiagnosticsResultSchema, {
		result: {
			case: "success",
			value: create(DiagnosticsSuccessSchema, {
				path,
				diagnostics: [],
				totalDiagnostics: 0,
			}),
		},
	});
}

function buildDiagnosticsErrorResult(_path: string, error: string) {
	return create(DiagnosticsResultSchema, {
		result: {
			case: "error",
			value: create(DiagnosticsErrorSchema, { error }),
		},
	});
}

function buildDiagnosticsRejectedResult(path: string, reason: string) {
	return create(DiagnosticsResultSchema, {
		result: {
			case: "rejected",
			value: create(DiagnosticsRejectedSchema, { path, reason }),
		},
	});
}

function parseToolArgsJson(text: string): unknown {
	const trimmed = text.trim();
	if (!trimmed) {
		return text;
	}
	try {
		return parseJsonWithRepair<unknown>(trimmed);
	} catch {
		return text;
	}
}

function decodeMcpArgValue(value: Uint8Array): unknown {
	try {
		const parsedValue = fromBinary(ValueSchema, value);
		const jsonValue = toJson(ValueSchema, parsedValue) as PbJsonValue;
		if (typeof jsonValue === "string") {
			return parseToolArgsJson(jsonValue);
		}
		return jsonValue;
	} catch {}
	const text = new TextDecoder().decode(value);
	return parseToolArgsJson(text);
}

function decodeMcpArgsMap(args?: Record<string, Uint8Array>): Record<string, unknown> | undefined {
	if (!args) {
		return undefined;
	}
	const decoded: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) {
		decoded[key] = decodeMcpArgValue(value);
	}
	return decoded;
}

function decodeMcpCall(args: {
	name: string;
	args: Record<string, Uint8Array>;
	toolCallId: string;
	providerIdentifier: string;
	toolName: string;
	smartModeApprovalOnly?: boolean;
}): CursorMcpCall {
	const decodedArgs: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args.args ?? {})) {
		decodedArgs[key] = decodeMcpArgValue(value);
	}
	return {
		name: args.name,
		providerIdentifier: args.providerIdentifier,
		toolName: args.toolName || args.name,
		toolCallId: args.toolCallId,
		args: decodedArgs,
		rawArgs: args.args ?? {},
		approvalOnly: args.smartModeApprovalOnly === true,
	};
}

/**
 * Map Cursor's `TodoStatus` enum onto display statuses. Cancelled (4) maps to
 * `abandoned` rather than collapsing to `pending`, which would resurrect a
 * task the model explicitly cancelled.
 */
function mapTodoStatusValue(status?: number): "pending" | "in_progress" | "completed" | "abandoned" {
	switch (status) {
		case 2:
			return "in_progress";
		case 3:
			return "completed";
		case 4:
			return "abandoned";
		default:
			return "pending";
	}
}

interface CursorTodoItem {
	id?: string;
	content?: string;
	status?: number;
	dependencies?: string[];
}

interface CursorTodoResult {
	result?: {
		case?: "success" | "error";
		value?: { todos?: CursorTodoItem[]; totalCount?: number; wasMerge?: boolean; error?: string };
	};
}

interface CursorUpdateTodosCall {
	args?: { todos?: CursorTodoItem[]; merge?: boolean };
	result?: CursorTodoResult;
}

interface CursorReadTodosCall {
	args?: { statusFilter?: number[]; idFilter?: string[] };
	result?: CursorTodoResult;
}

/**
 * `ToolCall` is a protobuf oneof, so a decoded message exposes the selected
 * variant as `tool: { case, value }` — NOT as a named property. Hand-built
 * fixtures use the flattened form, so both are accepted here.
 */
interface CursorTodoToolCall {
	tool?: { case?: string; value?: unknown };
	updateTodosToolCall?: CursorUpdateTodosCall;
	readTodosToolCall?: CursorReadTodosCall;
}

function selectTodoCalls(toolCall: CursorTodoToolCall): {
	update?: CursorUpdateTodosCall;
	read?: CursorReadTodosCall;
} {
	const oneof = toolCall.tool;
	if (oneof?.case === "updateTodosToolCall") return { update: oneof.value as CursorUpdateTodosCall };
	if (oneof?.case === "readTodosToolCall") return { read: oneof.value as CursorReadTodosCall };
	return { update: toolCall.updateTodosToolCall, read: toolCall.readTodosToolCall };
}

function mapTodoSnapshot(todos: CursorTodoItem[]) {
	return todos.map((todo) => ({
		content: typeof todo.content === "string" ? todo.content : "",
		status: mapTodoStatusValue(typeof todo.status === "number" ? todo.status : undefined),
	}));
}

interface CursorMcpToolCall {
	args?: {
		name?: string;
		toolName?: string;
		toolCallId?: string;
		args?: Record<string, Uint8Array>;
	};
}

interface CursorMcpToolCallCarrier {
	tool?: { case?: string; value?: unknown };
	mcpToolCall?: CursorMcpToolCall;
}

/**
 * `ToolCall.tool` is a protobuf oneof: a wire-decoded message exposes the
 * variant as `{ case, value }` and NEVER as a flattened property. The flat
 * fallback is kept for hand-shaped test fixtures.
 */
function selectMcpCall(toolCall: CursorMcpToolCallCarrier | undefined): CursorMcpToolCall | undefined {
	const oneof = toolCall?.tool;
	if (oneof?.case === "mcpToolCall") return oneof.value as CursorMcpToolCall;
	return toolCall?.mcpToolCall;
}

/**
 * The streamed `ToolCall` variants whose block the exec channel owns.
 *
 * Each of these is announced on the interaction stream AND dispatched as its
 * own `ExecServerMessage` frame, so the block is synthesized once, by the
 * exec handler, which is the side that has the result.
 */
const EXEC_OWNED_TOOL_CALL_CASES: ReadonlySet<string> = new Set([
	"piReadToolCall",
	"piBashToolCall",
	"piEditToolCall",
	"piWriteToolCall",
	"piGrepToolCall",
	"piFindToolCall",
	"piLsToolCall",
	"listMcpResourcesToolCall",
	"readMcpResourceToolCall",
]);

function isExecOwnedToolCall(toolCall: { tool?: { case?: string } } | undefined): boolean {
	const variant = toolCall?.tool?.case;
	return variant !== undefined && EXEC_OWNED_TOOL_CALL_CASES.has(variant);
}

/**
 * Close every tool-call block still open when the stream ends.
 *
 * Not just the last one started: with interleaved calls several can be open
 * at once, and an unclosed block leaves its live card animating and its call
 * unpaired. Only blocks fed by a streamed argument buffer get reparsed.
 * Server-owned blocks (`connect-scm`, `todo`) are also paired here: they are
 * stamped resolved the moment they open, so only their completion frame pairs
 * a result — a transport that closes before that frame would leave the call
 * unpaired. MCP blocks are excluded even when resolved: the exec dispatch
 * that marked them owns their result.
 */
export function flushOpenToolCalls(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: BlockState,
): void {
	const openBlocks = new Set<ToolCallState>(state.openToolCalls.values());
	if (state.currentToolCall) openBlocks.add(state.currentToolCall);
	for (const block of openBlocks) {
		const idx = output.content.indexOf(block);
		const partialJson = block[kStreamingPartialJson];
		if (partialJson !== undefined) {
			block.arguments = parseStreamingJson(partialJson);
			clearStreamingPartialJson(block);
		}
		const kind = block[kStreamingBlockKind];
		if (kind === "connect-scm" || kind === "todo") {
			void state.onToolResult?.({
				role: "toolResult",
				toolCallId: block.id,
				toolName: block.name,
				content: [{ type: "text", text: "The connection to Cursor closed before this call completed." }],
				isError: true,
				timestamp: Date.now(),
			});
		}
		stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: block, partial: output });
	}
	state.openToolCalls.clear();
	state.setToolCall(null);
}

/**
 * Retain a freshly opened streamed tool-call block, keyed by the interaction
 * envelope's `call_id`. `currentToolCall` is still set as the fallback for
 * frames that carry no `call_id`.
 */
function retainStreamedCall(state: BlockState, block: ToolCallState, envelopeId: string | undefined): void {
	if (envelopeId) state.openToolCalls.set(envelopeId, block);
	state.setToolCall(block);
}

/**
 * The open block a streamed update addresses, or `null` to ignore the update.
 *
 * Cursor interleaves calls: `start A, start B, complete A` is legal, so the
 * update must reach block A even though B opened last. An id naming no open
 * block is ignored rather than misapplied. A missing id falls back to the
 * current block.
 */
function resolveStreamedCall(state: BlockState, envelopeId: string | undefined): ToolCallState | null {
	if (!envelopeId) return state.currentToolCall;
	const keyed = state.openToolCalls.get(envelopeId);
	if (keyed) return keyed;
	const current = state.currentToolCall;
	return current && current[kStreamingEnvelopeId] === undefined ? current : null;
}

/** Release a settled block from both the keyed map and the current slot. */
function releaseStreamedCall(state: BlockState, block: ToolCallState): void {
	const envelopeId = block[kStreamingEnvelopeId];
	if (envelopeId) state.openToolCalls.delete(envelopeId);
	if (state.currentToolCall === block) state.setToolCall(null);
}

interface CursorConnectScmRepository {
	owner?: string;
	repo?: string;
}

interface CursorConnectScmCall {
	args?: {
		toolCallId?: string;
		target?: { case?: string; value?: { repository?: CursorConnectScmRepository } };
		github?: { repository?: CursorConnectScmRepository };
	};
	result?: { result?: { case?: string; value?: { error?: string; reason?: string } } };
}

interface CursorConnectScmCarrier {
	tool?: { case?: string; value?: unknown };
	connectScmToolCall?: CursorConnectScmCall;
}

function selectConnectScmCall(toolCall: CursorConnectScmCarrier | undefined): CursorConnectScmCall | undefined {
	const oneof = toolCall?.tool;
	if (oneof?.case === "connectScmToolCall") return oneof.value as CursorConnectScmCall;
	return toolCall?.connectScmToolCall;
}

function selectConnectScmRepository(call: CursorConnectScmCall | undefined): CursorConnectScmRepository | undefined {
	const target = call?.args?.target;
	if (target?.case === "github") return target.value?.repository;
	return call?.args?.github?.repository;
}

/** Render a settled `ConnectScmResult` as the text of its paired tool result. */
function describeConnectScmResult(call: CursorConnectScmCall | undefined): { text: string; isError: boolean } {
	const result = call?.result?.result;
	switch (result?.case) {
		case "success":
			return { text: "SCM connected", isError: false };
		case "error":
			return { text: result.value?.error || "SCM connection failed", isError: true };
		case "rejected":
			return { text: result.value?.reason || "SCM connection rejected", isError: true };
		default:
			return { text: "SCM connection reported no result", isError: true };
	}
}

/**
 * Extract the authoritative full todo list from a completed native todo call.
 * Only `result.success.todos` is authoritative; filtered/partial/ambiguous
 * responses return `null`, which the caller MUST treat as "nothing to mirror".
 */
function extractTodoSnapshot(
	toolCall: CursorTodoToolCall,
): { todos: ReturnType<typeof mapTodoSnapshot>; merged: boolean } | null {
	const { update, read } = selectTodoCalls(toolCall);
	if (read && ((read.args?.statusFilter?.length ?? 0) > 0 || (read.args?.idFilter?.length ?? 0) > 0)) {
		return null;
	}
	const call = update ?? read;
	if (!call) return null;
	const result = call.result?.result;
	if (result?.case !== "success") return null;
	const todos = result.value?.todos;
	if (!todos) return null;
	const totalCount = result.value?.totalCount;
	if (typeof totalCount === "number" && totalCount !== todos.length) {
		return null;
	}
	if (read && todos.length === 0) {
		return null;
	}
	const mapped = mapTodoSnapshot(todos);
	if (mapped.some((todo) => todo.content.length === 0)) return null;
	return {
		todos: mapped,
		merged: result.value?.wasMerge === true,
	};
}

/** Error text when the server itself rejected the call. */
function extractTodoError(toolCall: CursorTodoToolCall): string | null {
	const { update, read } = selectTodoCalls(toolCall);
	const result = (update ?? read)?.result?.result;
	if (result?.case !== "error") return null;
	const error = result.value?.error;
	return typeof error === "string" && error.length > 0 ? error : "Todo operation failed";
}

/** Args echoed onto the synthesized display block, for rendering only. */
function buildTodoDisplayArgs(toolCall: CursorTodoToolCall): {
	todos: ReturnType<typeof mapTodoSnapshot>;
	merge?: boolean;
} {
	const args = selectTodoCalls(toolCall).update?.args;
	return {
		todos: args?.todos ? mapTodoSnapshot(args.todos) : [],
		merge: args?.merge === true ? true : undefined,
	};
}

/**
 * Paired result for a server-resolved native todo call. Nothing else would
 * produce a `toolResult` for the block — and transcript rebuilds strip any
 * `toolCall` left unpaired.
 */
function buildTodoToolResult(
	toolCallId: string,
	snapshot: { todos: ReturnType<typeof mapTodoSnapshot> } | null,
	error: string | null,
): ToolResultMessage {
	const text = error ?? (snapshot ? formatTodoSnapshotSummary(snapshot.todos) : "Todo snapshot not mirrored");
	return {
		role: "toolResult",
		toolCallId,
		toolName: "todo",
		content: [{ type: "text", text }],
		isError: error !== null,
		timestamp: Date.now(),
	};
}

function formatTodoSnapshotSummary(todos: { status: string }[]): string {
	if (todos.length === 0) return "No todos";
	const done = todos.filter((todo) => todo.status === "completed").length;
	return `${done}/${todos.length} tasks completed`;
}

function buildMcpResultFromToolResult(_mcpCall: CursorMcpCall, toolResult: ToolResultMessage) {
	if (toolResult.isError) {
		return buildMcpErrorResult(toolResultToText(toolResult) || "MCP tool failed");
	}
	const content = toolResult.content.map((item) => {
		if (item.type === "image") {
			return create(McpToolResultContentItemSchema, {
				content: {
					case: "image",
					value: create(McpImageContentSchema, {
						data: Uint8Array.from(Buffer.from(item.data, "base64")),
						mimeType: item.mimeType,
					}),
				},
			});
		}
		return create(McpToolResultContentItemSchema, {
			content: {
				case: "text",
				value: create(McpTextContentSchema, { text: item.text }),
			},
		});
	});

	return create(McpResultSchema, {
		result: {
			case: "success",
			value: create(McpSuccessSchema, {
				content,
				isError: false,
			}),
		},
	});
}

function buildMcpToolNotFoundResult(mcpCall: CursorMcpCall) {
	return create(McpResultSchema, {
		result: {
			case: "toolNotFound",
			value: create(McpToolNotFoundSchema, { name: mcpCall.toolName, availableTools: [] }),
		},
	});
}

function buildMcpErrorResult(error: string) {
	return create(McpResultSchema, {
		result: {
			case: "error",
			value: create(McpErrorSchema, { error }),
		},
	});
}

/**
 * Merge the decoded completion-frame `McpArgs` map into the args assembled
 * from streamed `args_text_delta` snapshots.
 *
 * The completion frame is authoritative for the scalars it carries — but it
 * can omit oversized parameters entirely and can downgrade a structured value
 * to its raw string fallback. Rules per key:
 * - completion key absent → keep the streamed value.
 * - completion is a string while the streamed value is structured → keep the
 *   streamed value (the completion frame downgraded it).
 * - otherwise → completion wins.
 */
export function mergeCursorMcpToolCallArgs(
	streamed: Record<string, unknown> | undefined,
	completion: Record<string, unknown> | undefined,
): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...(streamed ?? {}) };
	if (!completion) return merged;
	for (const [key, completionValue] of Object.entries(completion)) {
		const streamedValue = merged[key];
		if (typeof completionValue === "string" && streamedValue !== null && typeof streamedValue === "object") {
			continue;
		}
		merged[key] = completionValue;
	}
	return merged;
}

function endCurrentTextBlock(output: AssistantMessage, stream: AssistantMessageEventStream, state: BlockState): void {
	const block = state.currentTextBlock;
	if (!block) return;
	const idx = output.content.indexOf(block);
	stream.push({
		type: "text_end",
		contentIndex: idx,
		content: block.text,
		partial: output,
	});
	state.setTextBlock(null);
}

function endCurrentThinkingBlock(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: BlockState,
): void {
	const block = state.currentThinkingBlock;
	if (!block) return;
	const idx = output.content.indexOf(block);
	stream.push({
		type: "thinking_end",
		contentIndex: idx,
		content: block.thinking,
		partial: output,
	});
	state.setThinkingBlock(null);
}

/**
 * Synthesize a completed `toolCall` content block for a Cursor exec-channel
 * native tool or for an MCP exec frame whose corresponding interaction block
 * is absent.
 *
 * Args arrive complete on the exec message, so the block opens and closes in
 * one step. Without this the persisted assistant message carries only
 * text/thinking blocks, and on replay the following `toolResult` messages
 * have no matching `toolCall.id`.
 *
 * The block is stamped with {@link kCursorExecResolved} so the agent loop's
 * execution pass skips it — Cursor's server-driven exec channel already ran
 * the tool via the bridge and buffered the result. Exported for tests.
 */
export function synthesizeCursorExecToolCall(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: BlockState,
	toolCallId: string,
	toolName: string,
	args: Record<string, unknown>,
): void {
	endCurrentTextBlock(output, stream, state);
	endCurrentThinkingBlock(output, stream, state);
	const block: ToolCallState = {
		type: "toolCall",
		id: toolCallId,
		name: toolName,
		arguments: omitUndefinedArgs(args),
		[kStreamingBlockIndex]: output.content.length,
		[kStreamingBlockKind]: "cursor-exec",
		[kCursorExecResolved]: true,
	};
	output.content.push(block);
	const idx = output.content.length - 1;
	stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
	stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: block, partial: output });
}

/**
 * Pair a `toolResult` for a synthesized block the client answered itself,
 * without ever consulting a handler. Frames answered from a fixed verdict —
 * no handler, no local execution — still need the pair: the block was stamped
 * {@link kCursorExecResolved}, so the agent loop emits no placeholder for it
 * and transcript rebuilds strip an unpaired call.
 */
async function pairSynthesizedExecResult(
	state: BlockState,
	onToolResult: CursorToolResultHandler | undefined,
	toolCallId: string,
	toolName: string,
	text: string,
	isError = true,
): Promise<void> {
	const synthesized: ToolResultMessage = {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp: Date.now(),
	};
	const sink = onToolResult ?? state.onToolResult;
	if (!sink) return;
	await sink(synthesized);
}

/**
 * Throttle threshold for mid-stream argument JSON parses: reparse only when
 * the buffer grew by this much since the last successful parse, keeping total
 * parse work bounded while the authoritative full parse runs on completion.
 */
const STREAMING_ARGS_REPARSE_DELTA = 1024;

/** Exported for tests: drives one Cursor interaction update through the streaming state machine. */
export function processInteractionUpdate(
	update: any,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: BlockState,
	usageState: UsageState,
): void {
	const updateCase = update.message?.case;

	log("interactionUpdate", updateCase);

	if (updateCase === "textDelta") {
		const delta = update.message.value.text || "";
		if (!state.currentTextBlock) {
			const block: TextContent & { [kStreamingBlockIndex]: number } = {
				type: "text",
				text: "",
				[kStreamingBlockIndex]: output.content.length,
			};
			output.content.push(block);
			state.setTextBlock(block);
			stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
		}
		state.currentTextBlock!.text += delta;
		const idx = output.content.indexOf(state.currentTextBlock!);
		stream.push({ type: "text_delta", contentIndex: idx, delta, partial: output });
	} else if (updateCase === "thinkingDelta") {
		const delta = update.message.value.text || "";
		if (!state.currentThinkingBlock) {
			const block: ThinkingContent & { [kStreamingBlockIndex]: number } = {
				type: "thinking",
				thinking: "",
				[kStreamingBlockIndex]: output.content.length,
			};
			output.content.push(block);
			state.setThinkingBlock(block);
			stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
		}
		state.currentThinkingBlock!.thinking += delta;
		const idx = output.content.indexOf(state.currentThinkingBlock!);
		stream.push({ type: "thinking_delta", contentIndex: idx, delta, partial: output });
	} else if (updateCase === "thinkingCompleted") {
		endCurrentThinkingBlock(output, stream, state);
	} else if (updateCase === "toolCallStarted" && selectConnectScmCall(update.message.value.toolCall)) {
		// `connect_scm` is resolved entirely server-side and has NO exec frame:
		// the streamed pair is the only signal this client sees. The
		// authoritative outcome rides on the COMPLETION's `result` oneof, so the
		// block is opened here and settled there.
		endCurrentTextBlock(output, stream, state);
		endCurrentThinkingBlock(output, stream, state);
		const scmCall = selectConnectScmCall(update.message.value.toolCall);
		const repository = selectConnectScmRepository(scmCall);
		const block: ToolCallState = {
			type: "toolCall",
			id: scmCall?.args?.toolCallId || update.message.value.callId || randomUUID(),
			name: "connect_scm",
			arguments: repository ? { owner: repository.owner, repo: repository.repo } : {},
			[kStreamingBlockIndex]: output.content.length,
			[kStreamingBlockKind]: "connect-scm",
			[kStreamingEnvelopeId]: update.message.value.callId || undefined,
			[kCursorExecResolved]: true,
		};
		output.content.push(block);
		retainStreamedCall(state, block, update.message.value.callId);
		stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
	} else if (updateCase === "toolCallStarted" && isExecOwnedToolCall(update.message.value.toolCall)) {
		// The exec channel already synthesized this block (and marked it
		// resolved) when it ran the tool locally, so the streamed announcement
		// must not create a second one.
		endCurrentTextBlock(output, stream, state);
		endCurrentThinkingBlock(output, stream, state);
		log("exec", "streamedToolCallOwnedByExec", { case: update.message.value.toolCall?.tool?.case });
	} else if (updateCase === "toolCallStarted") {
		endCurrentTextBlock(output, stream, state);
		endCurrentThinkingBlock(output, stream, state);
		const toolCall = update.message.value.toolCall;
		if (toolCall) {
			const mcpCall = selectMcpCall(toolCall);
			if (mcpCall) {
				const args = mcpCall.args || {};
				const id = args.toolCallId || randomUUID();
				const resolvedByExec = state.resolvedMcpToolCallIds.delete(id);
				if (resolvedByExec && output.content.some((block) => block.type === "toolCall" && block.id === id)) {
					return;
				}
				const block: ToolCallState = {
					type: "toolCall",
					id,
					// Same precedence as `decodeMcpCall` (`toolName || name`), which
					// is what the exec channel pairs its result under.
					name: args.toolName || args.name || "",
					arguments: {},
					[kStreamingBlockIndex]: output.content.length,
					[kStreamingPartialJson]: "",
					[kStreamingBlockKind]: "mcp",
					[kStreamingEnvelopeId]: update.message.value.callId || undefined,
				};
				if (resolvedByExec) {
					markCursorExecResolved(block);
				}
				output.content.push(block);
				retainStreamedCall(state, block, update.message.value.callId);
				stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
				return;
			}

			// Cursor resolves `update_todos` / `read_todos` server-side and
			// settles them on the tool call's `result`. Both blocks are stamped
			// resolved so the agent loop never runs them locally.
			const todoCalls = selectTodoCalls(toolCall);
			if (todoCalls.update || todoCalls.read) {
				const callId = update.message.value.callId || randomUUID();
				const block: ToolCallState = {
					type: "toolCall",
					id: callId,
					name: "todo",
					arguments: buildTodoDisplayArgs(toolCall),
					[kStreamingBlockIndex]: output.content.length,
					[kStreamingBlockKind]: "todo",
					[kStreamingEnvelopeId]: update.message.value.callId || undefined,
					[kCursorExecResolved]: true,
				};
				output.content.push(block);
				retainStreamedCall(state, block, update.message.value.callId);
				stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
			}
		}
	} else if (updateCase === "toolCallDelta" || updateCase === "partialToolCall") {
		// An argument delta belonging to a different call must not be appended
		// to this block's buffer, which would corrupt the JSON both parse.
		const target = resolveStreamedCall(state, update.message.value.callId);
		if (target?.[kStreamingBlockKind] === "mcp") {
			// Cursor's `args_text_delta` is "aggregated args text so far": each
			// delta is a cumulative snapshot. Strip the prefix we already have to
			// recover the new suffix; fall back to treating the value as an
			// incremental fragment when it doesn't extend the buffer.
			const snapshot: string = update.message.value.argsTextDelta || "";
			const current = target[kStreamingPartialJson] ?? "";
			const chunk = snapshot.startsWith(current) ? snapshot.slice(current.length) : snapshot;
			if (chunk.length === 0) {
				return;
			}
			const nextBuffer = current + chunk;
			target[kStreamingPartialJson] = nextBuffer;
			// Throttle mid-stream parses to keep total parse work bounded; the
			// authoritative full parse runs in `toolCallCompleted`.
			const lastParseLen = target[kStreamingLastParseLen] ?? 0;
			if (nextBuffer.length - lastParseLen >= STREAMING_ARGS_REPARSE_DELTA) {
				target.arguments = parseStreamingJson(nextBuffer);
				target[kStreamingLastParseLen] = nextBuffer.length;
			}
			const idx = output.content.indexOf(target);
			stream.push({ type: "toolcall_delta", contentIndex: idx, delta: chunk, partial: output });
		}
	} else if (updateCase === "toolCallCompleted") {
		// Correlate on the envelope's `call_id`, NOT the block id: MCP, Pi and
		// SCM blocks are filed under the id inside the call's `args`, and that
		// need not equal the envelope id.
		const settled = resolveStreamedCall(state, update.message.value.callId);
		if (settled) {
			const toolCall = update.message.value.toolCall;
			if (settled[kStreamingBlockKind] === "mcp") {
				// Authoritative full parse of the accumulated argument buffer.
				const partial = settled[kStreamingPartialJson];
				if (partial !== undefined) {
					settled.arguments = parseStreamingJson(partial);
				}
				const decodedArgs = decodeMcpArgsMap(selectMcpCall(toolCall)?.args?.args);
				settled.arguments = mergeCursorMcpToolCallArgs(
					settled.arguments as Record<string, unknown> | undefined,
					decodedArgs,
				);
			} else if (settled[kStreamingBlockKind] === "connect-scm") {
				// The authoritative outcome arrives only here. Late args are merged
				// too — a start frame may announce the call before the target
				// repository is known.
				const scmCall = selectConnectScmCall(toolCall);
				const repository = selectConnectScmRepository(scmCall);
				if (repository) {
					settled.arguments = { owner: repository.owner, repo: repository.repo };
				}
				const { text, isError } = describeConnectScmResult(scmCall);
				void state.onToolResult?.({
					role: "toolResult",
					toolCallId: settled.id,
					toolName: "connect_scm",
					content: [{ type: "text", text }],
					isError,
					timestamp: Date.now(),
				});
			} else if (settled[kStreamingBlockKind] === "todo") {
				// Only the server's success snapshot is authoritative. A completion
				// frame whose optional `toolCall` is absent still settles: the block
				// is already marked resolved, so nothing downstream pairs it.
				const snapshot = toolCall ? extractTodoSnapshot(toolCall) : null;
				const error = toolCall ? extractTodoError(toolCall) : null;
				if (snapshot) {
					settled.arguments = { todos: snapshot.todos, merged: snapshot.merged };
				}
				void state.onToolResult?.(buildTodoToolResult(settled.id, snapshot, error));
			}
			const idx = output.content.indexOf(settled);
			clearStreamingPartialJson(settled);
			stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: settled, partial: output });
			releaseStreamedCall(state, settled);
		}
	} else if (updateCase === "turnEnded") {
		output.stopReason = "stop";
	} else if (updateCase === "tokenDelta") {
		const tokenDelta = update.message.value;
		usageState.sawTokenDelta = true;
		output.usage.output += tokenDelta.tokens || 0;
		output.usage.totalTokens = output.usage.input + output.usage.output;
	}
}

function createBlobId(data: Uint8Array): Uint8Array {
	return new Uint8Array(createHash("sha256").update(data).digest());
}

function storeCursorBlob(blobStore: Map<string, Uint8Array>, data: Uint8Array): Uint8Array {
	const blobId = createBlobId(data);
	blobStore.set(Buffer.from(blobId).toString("hex"), data);
	return blobId;
}

function readCursorBlob(blobStore: Map<string, Uint8Array>, blobId: Uint8Array): Uint8Array {
	const data = blobStore.get(Buffer.from(blobId).toString("hex"));
	if (!data) {
		throw new Error("Cursor blob not found");
	}
	return data;
}

/**
 * Local tools Cursor already drives natively over the exec channel, so
 * advertising them again as MCP tools would give the model two ways to call
 * the same thing.
 */
const CURSOR_NATIVE_TOOL_NAMES = new Set(["bash", "read", "write", "delete", "ls", "grep", "todo"]);

/** Strip TypeBox symbol metadata down to a plain JSON Schema document. */
function toolParametersToJsonSchema(tool: Tool): unknown {
	try {
		return JSON.parse(JSON.stringify(tool.parameters));
	} catch {
		return { type: "object", properties: {}, required: [] };
	}
}

export function buildMcpToolDefinitions(tools: Tool[] | undefined): McpToolDefinition[] {
	if (!tools || tools.length === 0) {
		return [];
	}

	const advertisedTools = tools.filter((tool) => !CURSOR_NATIVE_TOOL_NAMES.has(tool.name));
	if (advertisedTools.length === 0) {
		return [];
	}

	return advertisedTools.map((tool) => {
		const jsonSchema = toolParametersToJsonSchema(tool);
		const schemaValue: PbJsonValue =
			jsonSchema && typeof jsonSchema === "object"
				? (jsonSchema as PbJsonValue)
				: { type: "object", properties: {}, required: [] };
		const inputSchema = toBinary(ValueSchema, fromJson(ValueSchema, schemaValue));
		return create(McpToolDefinitionSchema, {
			name: tool.name,
			description: tool.description || "",
			providerIdentifier: "pi-agent",
			toolName: tool.name,
			inputSchema,
		});
	});
}

/** Extract text content from a user message. */
function extractUserMessageText(msg: Message): string {
	if (msg.role !== "user") return "";
	const content = msg.content;
	if (typeof content === "string") return content.trim();
	const text = content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("\n");
	return text.trim();
}

function hasUserMessageImages(msg: Message): boolean {
	return msg.role === "user" && Array.isArray(msg.content) && msg.content.some((item) => item.type === "image");
}

type CursorRootPromptContentPart = { type: "text"; text: string } | { type: "image"; image: string; mediaType: string };

function buildCursorRootPromptContent(content: string | (TextContent | ImageContent)[]): CursorRootPromptContentPart[] {
	if (typeof content === "string") {
		const text = content.trim();
		return text ? [{ type: "text", text }] : [];
	}
	const parts: CursorRootPromptContentPart[] = [];
	for (const item of content) {
		if (item.type === "text") {
			const text = item.text.trim();
			if (text) {
				parts.push({ type: "text", text });
			}
		} else {
			parts.push({ type: "image", image: `data:${item.mimeType};base64,${item.data}`, mediaType: item.mimeType });
		}
	}
	return parts;
}

function cursorUserContentKey(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") {
		return content.trim();
	}
	const hash = createHash("sha256");
	for (const item of content) {
		hash.update(item.type);
		if (item.type === "text") {
			hash.update(item.text);
		} else {
			hash.update(item.mimeType);
			hash.update(item.data);
		}
	}
	return hash.digest("hex");
}

type CursorRootPromptAssistantContentPart =
	| { type: "text"; text: string }
	| { type: "tool-call"; toolCallId: string; toolName: string; args: Record<string, unknown> };

function buildCursorAssistantContent(msg: AssistantMessage): CursorRootPromptAssistantContentPart[] {
	const content: CursorRootPromptAssistantContentPart[] = [];
	for (const item of msg.content) {
		if (item.type === "text") {
			if (item.text) content.push({ type: "text", text: item.text });
		} else if (item.type === "toolCall") {
			content.push({
				type: "tool-call",
				toolCallId: item.id,
				toolName: item.name,
				args: item.arguments,
			});
		}
		// Thinking is never replayed: Cursor manages reasoning server-side and
		// foreign/hidden reasoning must not leak into history as native thinking.
	}
	return content;
}

/**
 * Index of the last user message in `messages`, or -1 if none. Used to
 * exclude the current user turn from history builders — it goes in the
 * `userMessageAction`, not in history structures.
 */
function findLastUserMessageIndex(messages: Message[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") {
			return i;
		}
	}
	return -1;
}

/**
 * Build one Cursor system-message JSON blob per system prompt. When no system
 * prompt is provided, returns a single default greeting so we never emit an
 * empty `rootPromptMessagesJson` head.
 */
export function buildCursorSystemPromptJsons(systemPrompt: string | undefined): string[] {
	const trimmed = systemPrompt?.trim();
	if (!trimmed) {
		return [JSON.stringify({ role: "system", content: "You are a helpful assistant." })];
	}
	return [JSON.stringify({ role: "system", content: trimmed })];
}

/**
 * Build `ConversationStateStructure.rootPromptMessagesJson` blob IDs for the
 * system prompt plus prior conversation history, as JSON blobs matching
 * Cursor's internal Vercel-AI-SDK-shaped message format.
 *
 * Cursor's server uses `rootPromptMessagesJson` (not `turns[]`) to build the
 * actual model prompt; `turns[]` is UI/display metadata. The active user
 * message is excluded because it is sent in the action.
 */
function buildRootPromptMessagesJson(
	messages: Message[],
	systemPromptIds: Uint8Array[],
	blobStore: Map<string, Uint8Array>,
	activeUserMessageIndex = findLastUserMessageIndex(messages),
): Uint8Array[] {
	const entries: Uint8Array[] = [...systemPromptIds];
	const pushJson = (obj: unknown) => {
		const bytes = new TextEncoder().encode(JSON.stringify(obj));
		entries.push(storeCursorBlob(blobStore, bytes));
	};

	for (let i = 0; i < messages.length; i++) {
		if (i === activeUserMessageIndex) break;
		const msg = messages[i];
		if (msg.role === "user") {
			const content = buildCursorRootPromptContent(msg.content);
			if (content.length === 0) continue;
			pushJson({ role: "user", content });
		} else if (msg.role === "assistant") {
			const content = buildCursorAssistantContent(msg);
			if (content.length === 0) continue;
			pushJson({ role: "assistant", content });
		} else if (msg.role === "toolResult") {
			// Emit even when the result text is empty: the assistant `tool-call`
			// is already in history, so dropping the pair would replay an
			// orphaned call.
			pushJson({
				role: "tool",
				id: msg.toolCallId,
				content: [
					{
						type: "tool-result",
						toolName: msg.toolName,
						toolCallId: msg.toolCallId,
						result: toolResultToText(msg),
						...(msg.isError ? { isError: true } : {}),
					},
				],
			});
		}
	}

	return entries;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value: unknown): value is PbJsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	if (!isPlainRecord(value)) return false;
	for (const key in value) {
		if (!isJsonValue(value[key])) return false;
	}
	return true;
}

function encodeCursorMcpArguments(toolCall: ToolCall): Record<string, Uint8Array> {
	const encoded: Record<string, Uint8Array> = {};
	for (const name in toolCall.arguments) {
		const value = toolCall.arguments[name];
		if (value === undefined) continue;
		if (!isJsonValue(value)) {
			throw new Error(`Cursor tool argument ${toolCall.name}.${name} is not JSON-serializable`);
		}
		encoded[name] = toBinary(ValueSchema, fromJson(ValueSchema, value));
	}
	return encoded;
}

function createCursorMcpResult(result: ToolResultMessage) {
	if (result.isError) {
		return create(McpToolResultSchema, {
			result: {
				case: "error",
				value: create(McpToolErrorSchema, { error: toolResultToText(result) }),
			},
		});
	}
	return create(McpToolResultSchema, {
		result: {
			case: "success",
			value: create(McpSuccessSchema, {
				content: result.content.map((item) =>
					item.type === "text"
						? create(McpToolResultContentItemSchema, {
								content: { case: "text", value: create(McpTextContentSchema, { text: item.text }) },
							})
						: create(McpToolResultContentItemSchema, {
								content: {
									case: "image",
									value: create(McpImageContentSchema, {
										data: Uint8Array.from(Buffer.from(item.data, "base64")),
										mimeType: item.mimeType,
									}),
								},
							}),
				),
			}),
		},
	});
}

function createCursorToolCallStep(toolCall: ToolCall, result: ToolResultMessage | undefined) {
	const mcpCall = create(McpToolCallSchema, {
		args: create(McpArgsSchema, {
			name: toolCall.name,
			args: encodeCursorMcpArguments(toolCall),
			toolCallId: toolCall.id,
			providerIdentifier: "pi-agent",
			toolName: toolCall.name,
		}),
		...(result ? { result: createCursorMcpResult(result) } : {}),
	});
	return create(ConversationStepSchema, {
		message: {
			case: "toolCall",
			value: create(ToolCallSchema, {
				tool: { case: "mcpToolCall", value: mcpCall },
				toolCallId: toolCall.id,
			}),
		},
	});
}

/**
 * Convert context.messages to Cursor's ConversationTurnStructure blob IDs.
 * Groups messages into turns: each turn is a user message followed by the
 * assistant's response. Excludes the active user message (which goes in the
 * action).
 */
function buildConversationTurns(
	messages: Message[],
	blobStore: Map<string, Uint8Array>,
	activeUserMessageIndex = findLastUserMessageIndex(messages),
): Uint8Array[] {
	const turns: Uint8Array[] = [];
	const historyEnd = activeUserMessageIndex >= 0 ? activeUserMessageIndex : messages.length;
	const toolResults = new Map<string, ToolResultMessage>();
	const pairedToolCallIds = new Set<string>();
	for (let index = 0; index < historyEnd; index++) {
		const message = messages[index];
		if (message.role === "toolResult") {
			toolResults.set(message.toolCallId, message);
		} else if (message.role === "assistant") {
			for (const item of message.content) {
				if (item.type === "toolCall") pairedToolCallIds.add(item.id);
			}
		}
	}

	let i = 0;
	while (i < messages.length) {
		const msg = messages[i];
		if (msg.role !== "user") {
			i++;
			continue;
		}
		if (i === activeUserMessageIndex) break;

		const userText = extractUserMessageText(msg);
		if (userText.length === 0 && !hasUserMessageImages(msg)) {
			i++;
			continue;
		}

		const userMessage = createCursorUserMessage(
			msg.content,
			userText,
			deterministicUuid(`u:${turns.length}:${cursorUserContentKey(msg.content)}`),
		);
		const userMessageBlobId = storeCursorBlob(blobStore, toBinary(UserMessageSchema, userMessage));
		const stepBlobIds: Uint8Array[] = [];
		i++;

		while (i < messages.length && messages[i].role !== "user") {
			const stepMsg = messages[i];
			if (stepMsg.role === "assistant") {
				for (const item of stepMsg.content) {
					let step: ConversationStep;
					if (item.type === "text") {
						if (!item.text) continue;
						step = create(ConversationStepSchema, {
							message: {
								case: "assistantMessage",
								value: create(AssistantMessageSchema, { text: item.text }),
							},
						});
					} else if (item.type === "thinking") {
						// Foreign/hidden reasoning never leaks into Cursor's turn
						// history as native thinking.
						continue;
					} else if (item.type === "toolCall") {
						step = createCursorToolCallStep(item, toolResults.get(item.id));
					} else {
						continue;
					}
					stepBlobIds.push(storeCursorBlob(blobStore, toBinary(ConversationStepSchema, step)));
				}
			} else if (stepMsg.role === "toolResult" && !pairedToolCallIds.has(stepMsg.toolCallId)) {
				const text = toolResultToText(stepMsg);
				if (text) {
					const prefix = stepMsg.isError ? "[Tool Error]" : "[Tool Result]";
					const step = create(ConversationStepSchema, {
						message: {
							case: "assistantMessage",
							value: create(AssistantMessageSchema, { text: `${prefix}\n${text}` }),
						},
					});
					stepBlobIds.push(storeCursorBlob(blobStore, toBinary(ConversationStepSchema, step)));
				}
			}
			i++;
		}

		const agentTurn = create(AgentConversationTurnStructureSchema, {
			userMessage: userMessageBlobId,
			steps: stepBlobIds,
		});
		const turn = create(ConversationTurnStructureSchema, {
			turn: {
				case: "agentConversationTurn",
				value: agentTurn,
			},
		});
		turns.push(storeCursorBlob(blobStore, toBinary(ConversationTurnStructureSchema, turn)));
	}

	return turns;
}

/** Exported for tests: decodes Cursor history blobs built from conversation messages. */
export function buildCursorHistoryForTest(
	messages: Message[],
	activeUserMessageIndex = findLastUserMessageIndex(messages),
): {
	rootPromptMessagesJson: unknown[];
	turnUserMessagesJson: unknown[];
	turnStepMessagesJson: unknown[][];
} {
	const blobStore = new Map<string, Uint8Array>();
	const rootPromptMessagesJson = buildRootPromptMessagesJson(messages, [], blobStore, activeUserMessageIndex).map(
		(blobId) => JSON.parse(new TextDecoder().decode(readCursorBlob(blobStore, blobId))),
	);
	const turnUserMessagesJson: unknown[] = [];
	const turnStepMessagesJson: unknown[][] = [];
	for (const turnBlobId of buildConversationTurns(messages, blobStore, activeUserMessageIndex)) {
		const turn = fromBinary(ConversationTurnStructureSchema, readCursorBlob(blobStore, turnBlobId));
		if (turn.turn.case !== "agentConversationTurn") {
			continue;
		}
		const userMessage = fromBinary(UserMessageSchema, readCursorBlob(blobStore, turn.turn.value.userMessage));
		turnUserMessagesJson.push(toJson(UserMessageSchema, userMessage));
		turnStepMessagesJson.push(
			turn.turn.value.steps.map((stepBlobId) => {
				const step = fromBinary(ConversationStepSchema, readCursorBlob(blobStore, stepBlobId));
				return toJson(ConversationStepSchema, step);
			}),
		);
	}
	return { rootPromptMessagesJson, turnUserMessagesJson, turnStepMessagesJson };
}

function createCursorUserMessage(
	content: string | (TextContent | ImageContent)[],
	text: string,
	messageId = randomUUID() as string,
) {
	const images = typeof content === "string" ? [] : extractImages(content);
	return create(UserMessageSchema, {
		text,
		messageId,
		...(images.length > 0
			? {
					selectedContext: create(SelectedContextSchema, {
						selectedImages: images,
					}),
				}
			: {}),
	});
}

function extractImages(content: (TextContent | ImageContent)[]) {
	return content
		.filter((item): item is ImageContent => item.type === "image")
		.map((image) =>
			create(SelectedImageSchema, {
				uuid: randomUUID(),
				mimeType: image.mimeType,
				dataOrBlobId: {
					case: "data",
					value: Uint8Array.from(Buffer.from(image.data, "base64")),
				},
			}),
		);
}

async function buildGrpcRequest(
	model: Model<"cursor-agent">,
	context: Context,
	options: CursorAgentOptions | undefined,
	state: {
		conversationId: string;
		blobStore: Map<string, Uint8Array>;
		conversationState?: ConversationStateStructure;
	},
): Promise<{
	requestBytes: Uint8Array;
	blobStore: Map<string, Uint8Array>;
	conversationState: ConversationStateStructure;
}> {
	const blobStore = state.blobStore;

	const systemPromptIds = buildCursorSystemPromptJsons(context.systemPrompt).map((json) =>
		storeCursorBlob(blobStore, new TextEncoder().encode(json)),
	);

	const activeUserMessageIndex = context.messages.length - 1;
	const activeMessage = context.messages[activeUserMessageIndex];
	const activeUserMessage = activeMessage?.role === "user" ? activeMessage : undefined;
	let userContent: string | (TextContent | ImageContent)[] | undefined;
	let userText = "";
	let hasUserImages = false;
	if (activeUserMessage) {
		userContent = activeUserMessage.content;
		if (typeof userContent === "string") {
			userText = userContent.trim();
		} else {
			userText = extractText(userContent);
			hasUserImages = hasImages(userContent);
		}
	}

	const action = create(ConversationActionSchema, {
		action:
			userContent && (userText.trim().length > 0 || hasUserImages)
				? {
						case: "userMessageAction",
						value: create(UserMessageActionSchema, {
							userMessage: createCursorUserMessage(userContent, userText),
						}),
					}
				: {
						case: "resumeAction",
						value: create(ResumeActionSchema, {}),
					},
	});

	// Build conversation turns from prior messages, excluding only the active
	// user message when the request is sending one. Resume actions must
	// preserve trailing tool results.
	const turns = buildConversationTurns(context.messages, blobStore, activeUserMessage ? activeUserMessageIndex : -1);

	// Cursor's server uses `rootPromptMessagesJson` (not `turns[]`) to build
	// the actual model prompt; without it multi-turn conversations lose prior
	// context.
	const rootPromptMessagesJson = buildRootPromptMessagesJson(
		context.messages,
		systemPromptIds,
		blobStore,
		activeUserMessage ? activeUserMessageIndex : -1,
	);

	// Preserve cached non-history state fields (todos, file states, summaries)
	// when the system prompt is unchanged; otherwise start fresh.
	const cachedPromptHead = state.conversationState?.rootPromptMessagesJson?.slice(0, systemPromptIds.length) ?? [];
	const hasMatchingPrompt =
		cachedPromptHead.length === systemPromptIds.length &&
		systemPromptIds.every((id, idx) => Buffer.from(cachedPromptHead[idx]).equals(id));
	const baseState =
		state.conversationState && hasMatchingPrompt
			? state.conversationState
			: create(ConversationStateStructureSchema, {
					rootPromptMessagesJson: systemPromptIds,
					turns: [],
					todos: [],
					pendingToolCalls: [],
					previousWorkspaceUris: [],
					fileStates: {},
					fileStatesV2: {},
					summaryArchives: [],
					turnTimings: [],
					subagentStates: {},
					selfSummaryCount: 0,
					readPaths: [],
				});

	// Always override `rootPromptMessagesJson` and `turns` with content freshly
	// built from `context.messages`: the server-echoed checkpoint replaces
	// historical user entries with empty placeholders.
	const conversationState = create(ConversationStateStructureSchema, {
		...baseState,
		rootPromptMessagesJson,
		turns,
	});

	const wireModelId = model.upstreamModelId ?? model.id;
	const cursorMaxMode = model.compat?.cursorMaxMode === true;
	const modelDetails = create(ModelDetailsSchema, {
		modelId: wireModelId,
		displayModelId: model.id,
		displayName: model.name,
		...(cursorMaxMode ? { maxMode: true } : undefined),
	});
	const requestedModel = create(RequestedModelSchema, {
		modelId: wireModelId,
		maxMode: cursorMaxMode,
	});

	const runRequest = create(AgentRunRequestSchema, {
		conversationState,
		action,
		modelDetails,
		requestedModel,
		conversationId: state.conversationId,
	});

	if (options?.customSystemPrompt) {
		runRequest.customSystemPrompt = options.customSystemPrompt;
	}

	await options?.onPayload?.(runRequest, model as Model<Api>);

	const clientMessage = create(AgentClientMessageSchema, {
		message: { case: "runRequest", value: runRequest },
	});

	const requestBytes = toBinary(AgentClientMessageSchema, clientMessage);

	log("info", "builtRunRequest", {
		bytes: requestBytes.length,
		tools: context.tools?.length ?? 0,
	});

	return { requestBytes, blobStore, conversationState };
}

function hasImages(content: (TextContent | ImageContent)[]): boolean {
	return content.some((item) => item.type === "image");
}

function extractText(content: (TextContent | ImageContent)[]): string {
	return content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

// ---------------------------------------------------------------------------
// Model discovery (GetUsableModels)
// ---------------------------------------------------------------------------

const CURSOR_GET_USABLE_MODELS_PATH = "/agent.v1.AgentService/GetUsableModels";
const CURSOR_DEFAULT_CONTEXT_WINDOW = 200_000;
const CURSOR_DEFAULT_MAX_TOKENS = 64_000;
/**
 * `GetUsableModels` carries no context-window field, so the 1M ceiling is
 * recovered from the signals Cursor does send: display-name "1M" labels and
 * the max-mode flag on Claude/Gemini families.
 */
const CURSOR_1M_CONTEXT_WINDOW = 1_000_000;
const CURSOR_1M_NAME_PATTERN = /\b1m\b/i;
const CURSOR_MAX_MODE_1M_ID_PATTERN = /claude|gemini/;
/**
 * Model-id families whose native catalogs are multimodal. Cursor-only or
 * text-only families (`composer-*`, `grok-code-*`) stay outside this pattern.
 */
const CURSOR_MULTIMODAL_ID_PATTERN = /claude|gemini|gpt-|codex/;

export interface CursorDiscoveredModel {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	cursorMaxMode: boolean;
}

/**
 * Fetches Cursor models through `GetUsableModels` (unary protobuf over
 * HTTP/2; the ALB rejects HTTP/1.1 with 464) and normalizes them.
 *
 * Returns `null` on request/decode failures; `[]` only when the endpoint
 * responds successfully with no usable models.
 */
export async function fetchCursorUsableModels(options: {
	apiKey: string;
	baseUrl?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}): Promise<CursorDiscoveredModel[] | null> {
	const timeoutMs = options.timeoutMs ?? 10_000;
	try {
		const requestPayload = create(GetUsableModelsRequestSchema, { customModelIds: [] });
		const body = toBinary(GetUsableModelsRequestSchema, requestPayload);
		const baseUrl = (options.baseUrl ?? CURSOR_API_URL).replace(/\/+$/, "");

		const responseBuffer = await new Promise<Uint8Array | null>((resolve) => {
			const client = http2.connect(baseUrl);
			const timer = setTimeout(() => {
				client.destroy();
				resolve(null);
			}, timeoutMs);
			const abort = () => {
				clearTimeout(timer);
				client.destroy();
				resolve(null);
			};
			options.signal?.addEventListener("abort", abort, { once: true });

			client.on("error", () => {
				clearTimeout(timer);
				resolve(null);
			});

			const req = client.request({
				":method": "POST",
				":path": CURSOR_GET_USABLE_MODELS_PATH,
				"content-type": "application/proto",
				te: "trailers",
				authorization: `Bearer ${options.apiKey}`,
				"x-ghost-mode": "true",
				"x-cursor-client-version": CURSOR_CLIENT_VERSION,
				"x-cursor-client-type": "cli",
			});

			const chunks: Buffer[] = [];
			req.on("data", (chunk: Buffer) => chunks.push(chunk));
			req.on("end", () => {
				clearTimeout(timer);
				client.close();
				resolve(new Uint8Array(Buffer.concat(chunks)));
			});
			req.on("error", () => {
				clearTimeout(timer);
				client.close();
				resolve(null);
			});
			req.on("response", (headers) => {
				const status = Number(headers[":status"] ?? 0);
				if (status < 200 || status >= 300) {
					clearTimeout(timer);
					client.close();
					resolve(null);
				}
			});

			if (body.length > 0) {
				req.end(Buffer.from(body));
			} else {
				req.end();
			}
		});

		if (!responseBuffer || responseBuffer.length === 0) {
			return null;
		}
		const decoded = decodeGetUsableModelsResponse(responseBuffer);
		if (!decoded) {
			return null;
		}

		const byId = new Map<string, CursorDiscoveredModel>();
		for (const model of decoded.models ?? []) {
			const id = model.modelId?.trim();
			if (!id) continue;
			const name = pickModelDisplayName(model, id);
			const labeled1M =
				CURSOR_1M_NAME_PATTERN.test(id) ||
				[model.displayName, model.displayNameShort, model.displayModelId, ...(model.aliases ?? [])].some(
					(candidate) => typeof candidate === "string" && CURSOR_1M_NAME_PATTERN.test(candidate),
				);
			const maxMode = model.maxMode === true;
			const contextWindow =
				labeled1M || (maxMode && CURSOR_MAX_MODE_1M_ID_PATTERN.test(id))
					? CURSOR_1M_CONTEXT_WINDOW
					: CURSOR_DEFAULT_CONTEXT_WINDOW;
			byId.set(id, {
				id,
				name,
				reasoning: Boolean(model.thinkingDetails),
				input: CURSOR_MULTIMODAL_ID_PATTERN.test(id.toLowerCase()) ? ["text", "image"] : ["text"],
				contextWindow,
				maxTokens: CURSOR_DEFAULT_MAX_TOKENS,
				cursorMaxMode: maxMode,
			});
		}
		return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
	} catch {
		return null;
	}
}

function decodeGetUsableModelsResponse(payload: Uint8Array) {
	const framedBody = decodeConnectUnaryBody(payload);
	if (framedBody) {
		try {
			return fromBinary(GetUsableModelsResponseSchema, framedBody);
		} catch {
			return null;
		}
	}
	try {
		return fromBinary(GetUsableModelsResponseSchema, payload);
	} catch {
		return null;
	}
}

function decodeConnectUnaryBody(payload: Uint8Array): Uint8Array | null {
	if (payload.length < 5) {
		return null;
	}

	let offset = 0;
	while (offset + 5 <= payload.length) {
		const flags = payload[offset];
		const view = new DataView(payload.buffer, payload.byteOffset + offset, payload.byteLength - offset);
		const messageLength = view.getUint32(1, false);
		const frameEnd = offset + 5 + messageLength;
		if (frameEnd > payload.length) {
			return null;
		}
		const compressionFlagSet = (flags & 0b0000_0001) !== 0;
		if (compressionFlagSet) {
			return null;
		}
		const endStreamFlagSet = (flags & 0b0000_0010) !== 0;
		if (!endStreamFlagSet) {
			return payload.subarray(offset + 5, frameEnd);
		}

		offset = frameEnd;
	}

	return null;
}

function pickModelDisplayName(
	model: { displayName?: string; displayNameShort?: string; displayModelId?: string; aliases?: string[] },
	fallbackId: string,
): string {
	const candidates = [model.displayName, model.displayNameShort, model.displayModelId, ...(model.aliases ?? [])];
	for (const candidate of candidates) {
		if (typeof candidate !== "string") {
			continue;
		}
		const trimmed = candidate.trim();
		if (trimmed) {
			return trimmed;
		}
	}
	return fallbackId;
}
