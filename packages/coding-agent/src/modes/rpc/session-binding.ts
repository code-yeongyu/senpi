import { bindToProviderScope, runWithProviderScope } from "@earendil-works/pi-ai/node/provider-scope";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { createRpcConnectionHandler, type RpcConnectionHandler, type RpcConnectionSink } from "./connection-handler.ts";
import type { SessionEventWriter } from "./session-event-writer.ts";
import type { RpcSessionEntry } from "./session-registry.ts";

/** A session-owned adapter around the classic command and extension-UI wiring. */
export interface RpcSessionBinding {
	handle(command: object): Promise<void>;
	dispose(): Promise<void>;
}

function enqueueRecords(writer: SessionEventWriter, sessionId: string, chunk: string): void {
	for (const line of chunk.split("\n")) {
		if (line) writer.enqueue(sessionId, JSON.parse(line) as object);
	}
}

/**
 * Creates the extension UI bridge and subscriptions within the entry's provider
 * scope. The classic handler remains the single source of command semantics.
 */
export async function createRpcSessionBinding(
	sessionId: string,
	entry: RpcSessionEntry,
	writer: SessionEventWriter,
	requestClose: () => void,
): Promise<RpcSessionBinding> {
	if (!entry.runtime) throw new Error("Session runtime was not created");
	const handler: RpcConnectionHandler = await runWithProviderScope(entry.scope, async () => {
		const taggedSink: RpcConnectionSink = {
			writeRaw: bindToProviderScope((chunk: string) => enqueueRecords(writer, sessionId, chunk)),
			waitForBackpressure: bindToProviderScope(async () => {}),
		};
		return createRpcConnectionHandler(entry.runtime! as AgentSessionRuntime, taggedSink, {
			sessionId,
			shutdownHandler: bindToProviderScope(requestClose),
			disposeRuntime: false,
		});
	});
	await handler.ready;
	return {
		handle: (command) => runWithProviderScope(entry.scope, () => handler.handleInputLine(JSON.stringify(command))),
		dispose: () => runWithProviderScope(entry.scope, () => handler.dispose()),
	};
}
