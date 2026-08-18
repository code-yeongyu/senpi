import * as http2 from "node:http2";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { AgentClientMessageSchema, AgentServerMessageSchema } from "../src/api/cursor-agent/gen/agent_pb.ts";
import type { CursorAgentOptions, CursorExecHandlers } from "../src/api/cursor-agent/types.ts";
import { frameConnectMessage, stream as streamCursorAgent } from "../src/api/cursor-agent.ts";
import type { AssistantMessage, Message, Model, ToolResultMessage } from "../src/types.ts";

export type ExecMode = "success" | "rejection" | "pending" | "unknown" | "shellStream" | "dispatchFailure";
type ClientFrame = ReturnType<typeof fromBinary<typeof AgentClientMessageSchema>>;

const EXEC_IDS: Record<ExecMode, number> = {
	success: 7,
	rejection: 8,
	pending: 9,
	unknown: 10,
	shellStream: 11,
	dispatchFailure: 12,
};

class ClientFrameReader {
	#buffer: Buffer = Buffer.alloc(0);
	readonly messages: ClientFrame[] = [];
	#waiters = new Set<() => void>();

	feed(chunk: Buffer): void {
		this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
		while (this.#buffer.length >= 5) {
			const length = this.#buffer.readUInt32BE(1);
			if (this.#buffer.length < 5 + length) break;
			const bytes = this.#buffer.subarray(5, 5 + length);
			this.#buffer = this.#buffer.subarray(5 + length);
			this.messages.push(fromBinary(AgentClientMessageSchema, bytes));
			for (const waiter of this.#waiters) waiter();
		}
	}

	async waitFor<T>(select: () => T | undefined, timeoutMs = 5000): Promise<T> {
		const found = select();
		if (found !== undefined) return found;
		return new Promise<T>((resolve, reject) => {
			const waiter = () => {
				const match = select();
				if (match === undefined) return;
				clearTimeout(timer);
				this.#waiters.delete(waiter);
				resolve(match);
			};
			const timer = setTimeout(() => {
				this.#waiters.delete(waiter);
				reject(new Error("Timed out waiting for client frame"));
			}, timeoutMs);
			this.#waiters.add(waiter);
		});
	}
}

function buildModel(baseUrl: string): Model<"cursor-agent"> {
	return {
		id: "claude-4.6-opus-high",
		name: "Opus 4.6",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	};
}

function serverFrame(init: Parameters<typeof create<typeof AgentServerMessageSchema>>[1]): Buffer {
	return frameConnectMessage(toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, init)));
}

function turnEndedFrame(): Buffer {
	return serverFrame({
		message: { case: "interactionUpdate", value: { message: { case: "turnEnded", value: {} } } },
	});
}

function toolResult(toolCallId: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

async function observeServerTask(task: Promise<void>): Promise<unknown> {
	try {
		await task;
		return undefined;
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
}

export async function runExecLifecycleScenario(mode: ExecMode): Promise<{
	readonly frames: readonly ClientFrame[];
	readonly message: AssistantMessage;
}> {
	const id = EXEC_IDS[mode];
	const pendingRead = Promise.withResolvers<ToolResultMessage>();
	const reader = new ClientFrameReader();
	const server = http2.createServer();
	const sessions = new Set<http2.ServerHttp2Session>();
	let serverTask: Promise<unknown> | undefined;
	server.on("session", (session) => {
		sessions.add(session);
		session.once("close", () => sessions.delete(session));
	});
	server.on("stream", (stream: http2.ServerHttp2Stream) => {
		stream.on("data", (chunk: Buffer) => reader.feed(chunk));
		stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
		serverTask = observeServerTask(
			(async () => {
				try {
					await reader.waitFor(() => reader.messages.find((item) => item.message.case === "runRequest"));
					stream.write(serverFrame({ message: { case: "execServerMessage", value: execFrame(mode, id) } }));
					if (mode === "unknown" || mode === "dispatchFailure") {
						await reader.waitFor(() => findControlFrames(reader.messages, "throw", id)[0], 500);
						await reader.waitFor(() => findControlFrames(reader.messages, "streamClose", id)[0], 500);
						stream.write(turnEndedFrame());
						return;
					}
					if (mode === "pending") {
						if (findControlFrames(reader.messages, "heartbeat", id).length !== 0) {
							throw new Error("Exec heartbeat arrived before the 3000ms interval");
						}
						await reader.waitFor(() => findControlFrames(reader.messages, "heartbeat", id)[0], 4500);
						pendingRead.resolve(toolResult("call-pending", "slow file contents"));
					}
					await reader.waitFor(() =>
						reader.messages.find(
							(item) =>
								item.message.case === "execClientMessage" &&
								item.message.value.message.case === (mode === "shellStream" ? "shellResult" : "readResult"),
						),
					);
					await reader.waitFor(() => findControlFrames(reader.messages, "streamClose", id)[0], 500);
					stream.write(turnEndedFrame());
				} finally {
					pendingRead.resolve(toolResult("call-pending", "cleanup"));
					stream.end();
				}
			})(),
		);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected TCP server address");
	try {
		const execHandlers = handlersFor(mode, pendingRead.promise);
		const stream = streamCursorAgent(
			buildModel(`http://127.0.0.1:${address.port}`),
			{ messages: [{ role: "user", content: "hello", timestamp: 0 }] satisfies Message[] },
			{ apiKey: "test-token", execHandlers } satisfies CursorAgentOptions,
		);
		for await (const _event of stream) {
			// Drain the public stream while the fake server enforces the wire contract.
		}
		const message = await stream.result();
		if (!serverTask) throw new Error("Expected server task");
		const serverError = await serverTask;
		if (serverError) throw serverError;
		return { frames: reader.messages, message };
	} finally {
		pendingRead.resolve(toolResult("call-pending", "cleanup"));
		for (const session of sessions) session.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

function execFrame(mode: ExecMode, id: number) {
	if (mode === "unknown") return { id, execId: `exec-${id}` };
	if (mode === "dispatchFailure") {
		return {
			id,
			execId: `exec-${id}`,
			message: {
				case: "mcpArgs" as const,
				value: {
					name: "review-failure",
					args: {},
					toolCallId: "call-dispatch-failure",
					providerIdentifier: "review",
					toolName: "review-failure",
					smartModeApprovalOnly: true,
				},
			},
		};
	}
	if (mode === "shellStream") {
		return {
			id,
			execId: `exec-${id}`,
			message: {
				case: "shellStreamArgs" as const,
				value: { command: "printf shell", toolCallId: "call-shell-stream" },
			},
		};
	}
	return {
		id,
		execId: `exec-${id}`,
		message: {
			case: "readArgs" as const,
			value: { path: `${mode}.ts`, toolCallId: `call-${mode}` },
		},
	};
}

function handlersFor(mode: ExecMode, pendingRead: Promise<ToolResultMessage>): CursorExecHandlers | undefined {
	if (mode === "dispatchFailure") {
		return {
			mcpApprovalPreflight: async () => {
				throw new Error("synthetic approval failure");
			},
		};
	}
	if (mode === "rejection" || mode === "unknown" || mode === "shellStream") return undefined;
	return {
		read: async (args) => (mode === "pending" ? await pendingRead : toolResult(args.toolCallId, "file contents")),
	};
}

export function findControlFrames(
	messages: readonly ClientFrame[],
	controlCase: "heartbeat" | "streamClose" | "throw",
	id: number,
) {
	return messages.filter(
		(item) =>
			item.message.case === "execClientControlMessage" &&
			item.message.value.message.case === controlCase &&
			item.message.value.message.value.id === id,
	);
}
