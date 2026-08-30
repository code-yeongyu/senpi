import { bindToProviderScope, runWithProviderScope } from "@earendil-works/pi-ai/node/provider-scope";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import {
	createRpcConnectionHandler,
	type RpcConnectionHandler,
	type RpcConnectionOptions,
	type RpcConnectionSink,
} from "./connection-handler.ts";
import type { SessionEventWriter } from "./session-event-writer.ts";
import type { RpcSessionEntry } from "./session-registry.ts";

/** A session-owned adapter around the classic command and extension-UI wiring. */
export interface RpcSessionBinding {
	handle(command: object): Promise<void>;
	cancelPendingExtensionUiRequests?(): void;
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
	options: Pick<RpcConnectionOptions, "capabilities"> = {},
): Promise<RpcSessionBinding> {
	if (!entry.runtime) throw new Error("Session runtime was not created");
	// Attachments share one entry, so resolve the host from the live runtime. In
	// particular, switch_session must use the entry's replacement-aware method
	// instead of a runtime captured during open_session.
	const runtimeHost = new Proxy({} as AgentSessionRuntime, {
		get(_target, property) {
			if (property === "switchSession" && entry.switchSession) return entry.switchSession;
			if (property === "setRebindSession")
				return (callback?: Parameters<AgentSessionRuntime["setRebindSession"]>[0]) => {
					entry.rebindSession = callback;
					entry.runtime?.setRebindSession(callback);
				};
			const runtime = entry.runtime;
			if (!runtime) throw new Error("Session runtime was not created");
			const value = Reflect.get(runtime, property, runtime);
			return typeof value === "function" ? value.bind(runtime) : value;
		},
	});
	const handler: RpcConnectionHandler = await runWithProviderScope(entry.scope, async () => {
		const taggedSink: RpcConnectionSink = {
			writeRaw: bindToProviderScope((chunk: string) => enqueueRecords(writer, sessionId, chunk)),
			waitForBackpressure: bindToProviderScope(async () => {}),
		};
		return createRpcConnectionHandler(runtimeHost, taggedSink, {
			sessionId,
			shutdownHandler: bindToProviderScope(requestClose),
			disposeRuntime: false,
			...options,
		});
	});
	await handler.ready;
	return {
		handle: (command) => runWithProviderScope(entry.scope, () => handler.handleInputLine(JSON.stringify(command))),
		cancelPendingExtensionUiRequests: () =>
			runWithProviderScope(entry.scope, () => handler.cancelPendingExtensionUiRequests()),
		dispose: () => runWithProviderScope(entry.scope, () => handler.dispose()),
	};
}
