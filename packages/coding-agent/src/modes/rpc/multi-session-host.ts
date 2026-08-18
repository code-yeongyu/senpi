import type { CreateAgentSessionRuntimeFactory } from "../../core/agent-session-runtime.ts";
import { envValue } from "../../core/brand.ts";
import {
	flushRawStdout,
	takeOverStdout,
	waitForRawStdoutBackpressure,
	writeRawStdout,
} from "../../core/output-guard.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import type { RpcConnectionSink } from "./connection-handler.ts";
import { parseClientCapabilities } from "./custom-capability.ts";
import { attachJsonlLineReader, MAX_RPC_LINE_CHARACTERS } from "./jsonl.ts";
import { rpcCommandShapeError } from "./rpc-input-validation.ts";
import type { RpcCommand, RpcResponse } from "./rpc-types.ts";
import { SessionCommandRouter } from "./session-command-router.ts";
import { SessionEventWriter } from "./session-event-writer.ts";
import { RpcSessionRegistry } from "./session-registry.ts";

export interface MultiSessionHostOptions {
	agentDir: string;
	createRuntime: CreateAgentSessionRuntimeFactory;
	cwd: string;
	permissionPreset?: string;
	creationModel?: { provider: string; modelId: string };
	initialThinkingLevel?: string;
}

/** Plain-stdio host with no eagerly-created AgentSessionRuntime. */
export async function runMultiSessionHost(options: MultiSessionHostOptions): Promise<never> {
	takeOverStdout();
	const sink: RpcConnectionSink = { writeRaw: writeRawStdout, waitForBackpressure: waitForRawStdoutBackpressure };
	const writer = new SessionEventWriter(sink.writeRaw, sink.waitForBackpressure);
	const capabilities = parseClientCapabilities(envValue("RPC_CLIENT_CAPABILITIES"));
	const router = new SessionCommandRouter(
		new RpcSessionRegistry({ agentDir: options.agentDir, createRuntime: options.createRuntime }),
		writer,
		options,
		undefined,
		{ capabilities },
	);
	let shuttingDown = false;
	const output = async (response: RpcResponse) => {
		await writer.enqueueControl(response);
	};
	const handle = async (line: string) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (cause) {
			await output({
				type: "response",
				command: "parse",
				success: false,
				error: `Failed to parse command: ${cause instanceof Error ? cause.message : String(cause)}`,
			});
			return;
		}
		const shapeError = rpcCommandShapeError(parsed);
		if (shapeError) {
			await output({
				type: "response",
				command: "parse",
				success: false,
				error: shapeError,
			});
			return;
		}
		const command = parsed as RpcCommand;
		const response = await router.handle(command);
		if (response) await output(response);
	};
	const shutdown = async (exitCode = 0): Promise<never> => {
		if (shuttingDown) process.exit(exitCode);
		shuttingDown = true;
		detach();
		await router.dispose();
		await writer.flush();
		await flushRawStdout();
		process.exit(exitCode);
	};
	const onEnd = () => void shutdown();
	process.stdin.on("end", onEnd);
	const detachReader = attachJsonlLineReader(process.stdin, (line) => void handle(line), {
		maxLineLength: MAX_RPC_LINE_CHARACTERS,
		onOversizedLine: () => {
			void output({
				type: "response",
				command: "parse",
				success: false,
				error: `RPC input line exceeds ${MAX_RPC_LINE_CHARACTERS} characters.`,
			});
		},
	});
	const detach = () => {
		detachReader();
		process.stdin.off("end", onEnd);
	};
	for (const signal of process.platform === "win32" ? (["SIGTERM"] as const) : (["SIGTERM", "SIGHUP"] as const)) {
		process.on(signal, () => {
			killTrackedDetachedChildren();
			void shutdown(signal === "SIGHUP" ? 129 : 143);
		});
	}
	return new Promise(() => {});
}
