import { bindToProviderScope, runWithProviderScope } from "@earendil-works/pi-ai/node/provider-scope";
import { randomUUID } from "node:crypto";
import { carriesExtensionOwner, type ExtensionOwner } from "./extension-owner.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import {
	type RecoveryCarrier,
	recoveryCarrier,
	setSessionRecoveryEpoch,
} from "../../core/session-recovery-identity.ts";
import { CanonicalPairing, carryCanonical } from "./compact-canonical-pairing.ts";
import type { CanonicalRecord, CanonicalUnit } from "./compact-lane-transitions.ts";
import { CompactProducerStamp } from "./compact-producer-stamp.ts";
import {
	createRpcConnectionHandler,
	type RpcConnectionHandler,
	type RpcConnectionOptions,
	type RpcConnectionSink,
} from "./connection-handler.ts";
import { createToolAttributionSpans } from "./session-attribution.ts";
import type { SessionEventWriter } from "./session-event-writer.ts";
import type { RpcSessionEntry } from "./session-registry.ts";
import { structuredLaneEnabled } from "./structured-session-records.ts";

/** A session-owned adapter around the classic command and extension-UI wiring. */
export interface RpcSessionBinding {
	handle(command: object): Promise<void>;
	cancelPendingExtensionUiRequests?(): void;
	/** A connection of the shared host left this session (`close_session`, a dropped or detached connection). */
	connectionDetached?(connectionId: string): void;
	/** `prompt` calls this binding started that have not settled, preflight included. */
	pendingPrompts?(): readonly Promise<unknown>[];
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
	options: Pick<RpcConnectionOptions, "capabilities" | "clientInfo" | "connectionRoles"> = {},
): Promise<RpcSessionBinding> {
	if (entry.worker) return entry.worker.bind(sessionId, writer, requestClose, options);
	if (!entry.runtime) throw new Error("Session runtime was not created");
	let rpcBindingGeneration = randomUUID();
	const rpcOwnersByConnection = new Map<string, ExtensionOwner>();
	// An in-process session executes its tools ON the host loop, so the tool this
	// session is inside is what the loop-lag watchdog blames for a stall. The record
	// stream already carries that transition; no extra subscription is needed.
	const toolSpans = createToolAttributionSpans(sessionId);
	const lane = entry.acceptance;
	if (lane) setSessionRecoveryEpoch(entry.runtime.session, lane.recoveryEpoch);
	if (lane) writer.registerAcceptance(sessionId, lane);
	// The manager whose journal the lane follows; a replacement's bootstrap moves the lane to the new one.
	let journaled = lane ? entry.runtime.session.sessionManager : undefined;
	// One acceptance unit per legacy record or block control (RULING-26 Q2); a worker frames it, in process the lane folds it.
	const pairing = structuredLaneEnabled() ? new CanonicalPairing() : undefined;
	const stamp = new CompactProducerStamp();
	const unit = (
		carrier: RecoveryCarrier | undefined,
		record: CanonicalRecord | undefined,
		legacy?: object,
	): CanonicalUnit | undefined => {
		const { ordinal, firstOrdinal } = stamp.stamp(carrier, record, legacy);
		return carrier && record && firstOrdinal !== undefined ? { record, carrier, ordinal, firstOrdinal } : undefined;
	};
	const enqueueRecord = (record: object): void => {
		toolSpans.observe(record);
		const canonical = pairing?.take(record);
		// Accepted before the writer serializes or routes it; a replacement is the next incarnation's bootstrap.
		if (lane && "type" in record && record.type === "session_replaced") {
			journaled = entry.runtime?.session.sessionManager;
			lane.bootstrap({ transcript: journaled?.beginTranscriptJournal() ?? [] });
			stamp.forget();
			if (entry.runtime) setSessionRecoveryEpoch(entry.runtime.session, lane.recoveryEpoch);
		} else if (lane) {
			lane.applyTranscript(journaled?.drainTranscript() ?? []);
			const carrier = recoveryCarrier(record);
			lane.accept(record, carrier, unit(carrier, canonical, record));
		} else if (canonical) carryCanonical(record, canonical);
		writer.enqueue(sessionId, record);
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
	// A reply can be written after its session closed: a prompt's preflight that outlived the client's
	// deadline answers once the client already discarded the session. That record has no reader left, so it
	// is dropped with one line naming the session instead of throwing "Provider scope is closed" out of
	// an unawaited prompt (senpi#2871).
	let droppedAfterClose = false;
	const handler: RpcConnectionHandler = await runWithProviderScope(entry.scope, async () => {
		const writeInScope = bindToProviderScope(enqueueRecord);
		const dropAfterClose = (): void => {
			if (!droppedAfterClose)
				process.stderr.write(
					`senpi rpc host: dropped a record for closed session ${sessionId} at ${new Date().toISOString()}\n`,
				);
			droppedAfterClose = true;
		};
		const writeRecord = (record: object): void => {
			if (entry.scope.state === "closed") return dropAfterClose();
			writeInScope(record);
		};
		const writeStructuredInScope = bindToProviderScope((record: object) => {
			writer.structuredLanes.accept(sessionId, record);
			const control = pairing?.structured(record);
			if (control && lane) lane.acceptControl(unit(control.carrier, control.record));
			else if (control) writer.enqueueCanonical(sessionId, control);
		});
		const taggedSink: RpcConnectionSink = {
			writeRecord,
			...(structuredLaneEnabled()
				? {
						writeStructured: (record: object) => {
							if (entry.scope.state !== "closed") writeStructuredInScope(record);
						},
						structuredFailed: (cause: unknown) => {
							if (lane) lane.compactUnavailable(cause);
							else writer.canonicalUnavailable(sessionId, cause);
						},
					}
				: {}),
			// A late raw reply after the scope closed is dropped like any record (senpi#2871); while the scope is
			// open, records arrive only through writeRecord, so a raw write is a wiring bug.
			writeRaw: () => {
				if (entry.scope.state === "closed") return dropAfterClose();
				throw new Error("Shared session bindings deliver records through writeRecord, never writeRaw");
			},
			waitForBackpressure: bindToProviderScope(async () => {}),
		};
		return createRpcConnectionHandler(runtimeHost, taggedSink, {
			sessionId,
			shutdownHandler: bindToProviderScope(requestClose),
			disposeRuntime: false,
			rpcOwner: () => {
				const owner = writer.connectionContext.owner;
				const connection = writer.currentConnection();
				if (owner && connection) rpcOwnersByConnection.set(connection, owner);
				return owner;
			},
			retireRpcBinding: () => {
				rpcBindingGeneration = randomUUID();
				rpcOwnersByConnection.clear();
			},
			publishLoadedSurfacesChanged: (previous, digest) => {
				if (entry.scope.state !== "closed") writer.publishLoadedSurfacesChanged(sessionId, previous, digest);
			},
			...options,
			workerSecurityBridge: writer.workerSecurityBridge,
			grantDialogSettled: (id) => writer.settleGrantDialog(sessionId, id),
			bindSecurityPresentation: (session, ui) =>
				writer.bindSecurityPresentations(sessionId, session.sessionId, session.securityNotices, ui),
			bindMcpForms: (session, ui) =>
				writer.bindMcpForms(sessionId, session.sessionId, ui, () => session.admitHumanAnswer()),
			clientInfo:
				options.clientInfo === undefined
					? undefined
					: {
							...options.clientInfo,
							hasCapability: (connection, capability) =>
								writer.getConnectionCapabilities(connection)?.includes(capability) === true,
						},
		});
	});
	await handler.ready;
	return {
		handle: (command) => {
			if (writer.handleMcpForm(command)) return Promise.resolve();
			const invoke = () => runWithProviderScope(entry.scope, () => handler.handleInputLine(JSON.stringify(command)));
			return carriesExtensionOwner(command)
				? writer.connectionContext.withBinding(rpcBindingGeneration, invoke)
				: invoke();
		},
		cancelPendingExtensionUiRequests: () =>
			runWithProviderScope(entry.scope, () => handler.cancelPendingExtensionUiRequests()),
		pendingPrompts: () => handler.pendingPrompts(),
		connectionDetached: (connectionId) => {
			rpcOwnersByConnection.get(connectionId)?.retire();
			rpcOwnersByConnection.delete(connectionId);
			runWithProviderScope(entry.scope, () => handler.connectionDetached(connectionId));
		},
		dispose: () => {
			toolSpans.closeAll();
			return runWithProviderScope(entry.scope, () => handler.dispose());
		},
	};
}
