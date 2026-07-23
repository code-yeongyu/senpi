import type { CreateAgentSessionRuntimeFactory } from "../../core/agent-session-runtime.ts";
import {
	flushRawStdout,
	takeOverStdout,
	waitForRawStdoutBackpressure,
	writeRawStdout,
} from "../../core/output-guard.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import type { RpcConnectionSink } from "./connection-handler.ts";
import { attachJsonlLineReader } from "./jsonl.ts";
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
	const writer = new SessionEventWriter(sink.writeRaw);
	const router = new SessionCommandRouter(
		new RpcSessionRegistry({ agentDir: options.agentDir, createRuntime: options.createRuntime }),
		writer,
		options,
	);
	let shuttingDown = false;
	const output = async (response: RpcResponse) => {
		sink.writeRaw(`${JSON.stringify(response)}\n`);
		await sink.waitForBackpressure();
	};
	const handle = async (line: string) => {
		let command: RpcCommand;
		try {
			command = JSON.parse(line) as RpcCommand;
		} catch (cause) {
			await output({
				type: "response",
				command: "parse",
				success: false,
				error: `Failed to parse command: ${cause instanceof Error ? cause.message : String(cause)}`,
			});
			return;
		}
		const response = await router.handle(command);
		if (response) await output(response);
	};
	const shutdown = async (exitCode = 0): Promise<never> => {
		if (shuttingDown) process.exit(exitCode);
		shuttingDown = true;
		detach();
		await router.dispose();
		await flushRawStdout();
		process.exit(exitCode);
	};
	const onEnd = () => void shutdown();
	process.stdin.on("end", onEnd);
	const detachReader = attachJsonlLineReader(process.stdin, (line) => void handle(line));
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
