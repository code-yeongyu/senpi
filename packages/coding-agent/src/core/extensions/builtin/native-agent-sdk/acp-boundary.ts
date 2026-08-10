import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { client, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { ACP_PROCESS_GROUP, terminateAcpProcess } from "./acp-process.ts";
import { contentInput, type TrackedToolCall, trackToolCall } from "./acp-tool-calls.ts";
import { requestNativeAgentPermission } from "./permission.ts";
import type { NativeAgentEvent, NativeAgentRequest } from "./stream.ts";

export type NativeAgentSessionConfigOption = {
	readonly configId: string;
	readonly value: string;
};

const INHERITED_ENV_KEYS: readonly string[] = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"TMPDIR",
	"TEMP",
	"TMP",
	"LANG",
	"LC_ALL",
	"TERM",
	"COLORTERM",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_CACHE_HOME",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
];

class NativeAgentEventQueue implements AsyncIterableIterator<NativeAgentEvent> {
	private readonly values: NativeAgentEvent[] = [];
	private reader:
		| {
				readonly resolve: (result: IteratorResult<NativeAgentEvent>) => void;
				readonly reject: (error: unknown) => void;
		  }
		| undefined;
	private closed = false;
	private failed = false;
	private failure: unknown;

	[Symbol.asyncIterator](): AsyncIterableIterator<NativeAgentEvent> {
		return this;
	}

	next(): Promise<IteratorResult<NativeAgentEvent>> {
		const value = this.values.shift();
		if (value !== undefined) return Promise.resolve({ value, done: false });
		if (this.failed) return Promise.reject(this.failure);
		if (this.closed) return Promise.resolve({ value: undefined, done: true });
		return new Promise((resolve, reject) => {
			this.reader = { resolve, reject };
		});
	}

	push(value: NativeAgentEvent): void {
		if (this.closed || this.failed) return;
		const reader = this.reader;
		if (reader !== undefined) {
			this.reader = undefined;
			reader.resolve({ value, done: false });
			return;
		}
		this.values.push(value);
	}

	close(): void {
		if (this.closed || this.failed) return;
		this.closed = true;
		const reader = this.reader;
		this.reader = undefined;
		reader?.resolve({ value: undefined, done: true });
	}

	fail(error: unknown): void {
		if (this.closed || this.failed) return;
		this.failed = true;
		this.failure = error;
		const reader = this.reader;
		this.reader = undefined;
		reader?.reject(error);
	}
}

export function nativeAgentEnvironment(
	credentialEnvKeys: readonly string[],
	source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const environment: Record<string, string> = {};
	for (const key of [...INHERITED_ENV_KEYS, ...credentialEnvKeys]) {
		const value = source[key];
		if (value !== undefined) environment[key] = value;
	}
	return environment;
}

function writableFor(stdin: Writable): WritableStream<Uint8Array> {
	return new WritableStream({
		write(chunk) {
			return new Promise<void>((resolve, reject) => {
				stdin.write(chunk, (error) => {
					if (error) reject(error);
					else resolve();
				});
			});
		},
		close() {
			stdin.end();
		},
	});
}

function readableFor(stdout: Readable, terminate: () => Promise<void>): ReadableStream<Uint8Array> {
	let closed = false;
	return new ReadableStream({
		start(controller) {
			stdout.on("data", (chunk: Buffer) => {
				if (!closed) controller.enqueue(new Uint8Array(chunk));
			});
			stdout.on("end", () => {
				if (!closed) {
					closed = true;
					controller.close();
				}
			});
			stdout.on("error", (error) => {
				if (!closed) {
					closed = true;
					controller.error(error);
				}
			});
		},
		cancel() {
			closed = true;
			void terminate().catch(() => {});
		},
	});
}

export async function* runAcpAgent(
	request: NativeAgentRequest,
	command: string,
	args: readonly string[],
	clientName: string,
	credentialEnvKeys: readonly string[],
	sessionConfigOptions: readonly NativeAgentSessionConfigOption[] = [],
): AsyncIterable<NativeAgentEvent> {
	if (request.signal?.aborted === true) throw new Error("Operation aborted");
	const child = spawn(command, [...args], {
		cwd: request.cwd,
		detached: ACP_PROCESS_GROUP,
		env: nativeAgentEnvironment(credentialEnvKeys),
		stdio: ["pipe", "pipe", "pipe"],
	});
	if (!child.stdin || !child.stdout || !child.stderr) throw new Error(`${clientName} ACP stdio was not created`);
	child.stderr.resume();
	const childError = new Promise<never>((_resolve, reject) => child.once("error", reject));
	let termination: Promise<void> | undefined;
	const terminateOnce = (): Promise<void> => {
		termination ??= terminateAcpProcess(child);
		return termination;
	};
	const onAbort = (): void => {
		void terminateOnce().catch(() => {});
	};
	request.signal?.addEventListener("abort", onAbort, { once: true });
	const events = new NativeAgentEventQueue();
	const toolCalls = new Map<string, TrackedToolCall>();
	let completed: Promise<void> | undefined;
	try {
		const stream = ndJsonStream(writableFor(child.stdin), readableFor(child.stdout, terminateOnce));
		const connection = client({ name: clientName })
			.onRequest(methods.client.session.requestPermission, async ({ params }) => {
				const tracked = toolCalls.get(params.toolCall.toolCallId);
				const allowed = await requestNativeAgentPermission(request.sessionId, {
					provider: request.provider,
					kind: params.toolCall.kind ?? tracked?.kind,
					title: params.toolCall.title ?? tracked?.title ?? params.toolCall.kind ?? "Native agent tool request",
					rawInput: params.toolCall.rawInput ?? contentInput(params.toolCall.content) ?? tracked?.rawInput,
				});
				const option = params.options.find((candidate) =>
					allowed ? candidate.kind === "allow_once" : candidate.kind === "reject_once",
				);
				return option
					? { outcome: { outcome: "selected", optionId: option.optionId } }
					: { outcome: { outcome: "cancelled" } };
			})
			.connectWith(stream, async (context) => {
				const initialized = await context.request(methods.agent.initialize, {
					protocolVersion: PROTOCOL_VERSION,
					clientCapabilities: {},
				});
				return context.buildSession(request.cwd).withSession(async (session) => {
					try {
						for (const option of sessionConfigOptions) {
							await context.request(methods.agent.session.setConfigOption, {
								sessionId: session.sessionId,
								configId: option.configId,
								value: option.value,
							});
						}
						const promptPromise = session.prompt(request.prompt);
						for (;;) {
							const message = await session.nextUpdate();
							switch (message.kind) {
								case "session_update": {
									const update = message.update;
									trackToolCall(update, toolCalls);
									if (
										update.sessionUpdate === "agent_message_chunk" &&
										update.content.type === "text" &&
										update.content.text.length > 0
									) {
										events.push({ type: "text", text: update.content.text });
									}
									break;
								}
								case "stop":
									await promptPromise;
									return;
								default:
									return assertNever(message);
							}
						}
					} finally {
						if (initialized.agentCapabilities?.sessionCapabilities?.close != null) {
							await context.request(methods.agent.session.close, { sessionId: session.sessionId });
						}
					}
				});
			});
		completed = Promise.race([connection, childError]).then(
			() => events.close(),
			(error: unknown) => events.fail(error),
		);
		for await (const event of events) yield event;
		await completed;
	} finally {
		request.signal?.removeEventListener("abort", onAbort);
		await terminateOnce();
		await completed;
	}
}

function assertNever(value: never): never {
	throw new Error(`Unsupported ACP session message: ${String(value)}`);
}
