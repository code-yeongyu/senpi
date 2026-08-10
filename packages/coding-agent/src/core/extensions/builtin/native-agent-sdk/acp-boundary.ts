import { type ChildProcess, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { client, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { reapProcessTree } from "../mcp/process-tree.ts";
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

function readableFor(stdout: Readable, terminate: () => void): ReadableStream<Uint8Array> {
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
			terminate();
		},
	});
}

async function terminate(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
	const pid = child.pid;
	if (pid === undefined) child.kill();
	else await reapProcessTree(pid, { termWaitMs: 500, killWaitMs: 500 });
	await closed;
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
		env: nativeAgentEnvironment(credentialEnvKeys),
		stdio: ["pipe", "pipe", "pipe"],
	});
	if (!child.stdin || !child.stdout || !child.stderr) throw new Error(`${clientName} ACP stdio was not created`);
	child.stderr.resume();
	const childError = new Promise<never>((_resolve, reject) => child.once("error", reject));
	let termination: Promise<void> | undefined;
	const terminateOnce = (): Promise<void> => {
		termination ??= terminate(child);
		return termination;
	};
	const onAbort = (): void => {
		void terminateOnce();
	};
	request.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const stream = ndJsonStream(
			writableFor(child.stdin),
			readableFor(child.stdout, () => void terminateOnce()),
		);
		const connection = client({ name: clientName })
			.onRequest(methods.client.session.requestPermission, async ({ params }) => {
				const allowed = await requestNativeAgentPermission(request.sessionId, {
					provider: request.provider,
					kind: params.toolCall.kind ?? undefined,
					title: params.toolCall.title ?? params.toolCall.kind ?? "Native agent tool request",
					rawInput: params.toolCall.rawInput,
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
						const responseText = await session.readText();
						await promptPromise;
						return responseText;
					} finally {
						if (initialized.agentCapabilities?.sessionCapabilities?.close != null) {
							await context.request(methods.agent.session.close, { sessionId: session.sessionId });
						}
					}
				});
			});
		const text = await Promise.race([connection, childError]);
		if (text.length > 0) yield { type: "text", text };
	} finally {
		request.signal?.removeEventListener("abort", onAbort);
		await terminateOnce();
	}
}
