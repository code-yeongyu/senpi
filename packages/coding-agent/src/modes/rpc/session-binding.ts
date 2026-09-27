import { bindToProviderScope, runWithProviderScope } from "@earendil-works/pi-ai/node/provider-scope";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import {
	createRpcConnectionHandler,
	type RpcConnectionHandler,
	type RpcConnectionOptions,
	type RpcConnectionSink,
} from "./connection-handler.ts";
import { createToolAttributionSpans } from "./session-attribution.ts";
import type { SessionEventWriter } from "./session-event-writer.ts";
import type { RpcSessionEntry } from "./session-registry.ts";

/** A session-owned adapter around the classic command and extension-UI wiring. */
export interface RpcSessionBinding {
	handle(command: object): Promise<void>;
	cancelPendingExtensionUiRequests?(): void;
	rerenderComponents?(): void;
	dispose(): Promise<void>;
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
	options: Pick<RpcConnectionOptions, "capabilities" | "sharedWidth"> = {},
): Promise<RpcSessionBinding> {
	if (entry.worker) return entry.worker.bind(sessionId, writer, requestClose, options);
	if (!entry.runtime) throw new Error("Session runtime was not created");
	// An in-process session executes its tools ON the host loop, so the tool this
	// session is inside is what the loop-lag watchdog blames for a stall. The record
	// stream already carries that transition; no extra subscription is needed.
	const toolSpans = createToolAttributionSpans(sessionId);
	let disposed = false;
	const enqueueRecords = (chunk: string): void => {
		for (const line of chunk.split("\n")) {
			if (!line) continue;
			const record = JSON.parse(line) as object;
			toolSpans.observe(record);
			writer.enqueue(sessionId, record);
		}
	};
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
		const scopedEnqueue = bindToProviderScope(enqueueRecords);
		const scopedClose = bindToProviderScope(requestClose);
		const taggedSink: RpcConnectionSink = {
			// Async commands can finish after disposal and after the provider scope
			// closes. Check the binding lifetime before entering that closed scope.
			writeRaw: (chunk) => {
				if (!disposed) scopedEnqueue(chunk);
			},
			waitForBackpressure: async () => {},
		};
		return createRpcConnectionHandler(runtimeHost, taggedSink, {
			sessionId,
			shutdownHandler: () => {
				if (!disposed) scopedClose();
			},
			disposeRuntime: false,
			eventFlushScheduler: (flush) => flush(),
			...options,
		});
	});
	await handler.ready;
	return {
		handle: (command) => runWithProviderScope(entry.scope, () => handler.handleInputLine(JSON.stringify(command))),
		cancelPendingExtensionUiRequests: () =>
			runWithProviderScope(entry.scope, () => handler.cancelPendingExtensionUiRequests()),
		rerenderComponents: () => runWithProviderScope(entry.scope, () => handler.rerenderComponents()),
		dispose: async () => {
			toolSpans.closeAll();
			try {
				await runWithProviderScope(entry.scope, () => handler.dispose());
			} finally {
				disposed = true;
			}
		},
	};
}
