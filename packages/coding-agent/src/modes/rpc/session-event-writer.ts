import { SessionConnectionContext } from "./session-connection-context.ts";
import type { ExtensionUIContext, SessionKind } from "../../core/extensions/types.ts";
import { bindPrivateMcpForms, type McpFormBinding } from "../../core/mcp-form-types.ts";
import { McpPresenterAuthority, type McpPresenterConnection } from "./mcp-presenter-authority.ts";
import type { SecurityNoticeSnapshot, SecurityNoticeState } from "../../core/security-notices.ts";
import { MEDIA_PLACEHOLDERS_CAPABILITY } from "./custom-capability.ts";
import { normalizeJsonValue } from "./json-normal-value.ts";
import { SessionStructuredLanes } from "./session-structured-lanes.ts";
import { serializeJsonLine } from "./jsonl.ts";
import { observeLifecycleDelivery } from "./lifecycle-delivery.ts";
import { type MediaPersister, omitNormalInlineMedia } from "./media-placeholders.ts";
import type {
	RpcHostLifecycleEvent,
	RpcOpenQueuedEvent,
	RpcSessionClosedEvent,
	RpcSessionClosedReason,
	RpcSessionParkedEvent,
} from "./rpc-types.ts";
import { RpcSecurityPresentations } from "./security-presentations.ts";
import type { SessionAcceptanceLane } from "./session-acceptance-lane.ts";
import { SessionEventFanout, type SessionEventWriterConnection } from "./session-event-fanout.ts";
import { SessionOpenTurns } from "./session-open-turns.ts";
import { type QueueNode, type RecordQueue, SessionRecordAccounting } from "./session-record-accounting.ts";
import { causeOfRecord, type SessionStatusActor, terminalOfLifecycle } from "./session-status.ts";
import { type SessionOpenedRecord, sessionOpenedLines } from "./session-status-opened.ts";
import { SessionStatusStream } from "./session-status-stream.ts";
import { SurfaceDigestDedupe } from "./session-surface-dedupe.ts";
import type { SocketEventSinkActor } from "./socket-event-fanout.ts";
import { isCorrelatedReply } from "./socket-peer-recovery.ts";

export type { SessionEventWriterConnection } from "./session-event-fanout.ts";

/** Await every actor's drain; a failed actor is a cut peer, not a writer failure. */
const settleActors = (actors: readonly SocketEventSinkActor[]): Promise<void> =>
	Promise.all(actors.map((actor) => actor.flush().catch(() => undefined))).then(() => undefined);

/** Await every actor's ACCEPTANCE of what it was given; never the peer's kernel drain. */
const acceptActors = (actors: readonly SocketEventSinkActor[]): Promise<void> =>
	Promise.all(actors.map((actor) => actor.waitForAcceptance())).then(() => undefined);

type RawWriter = (chunk: string) => void;
type BackpressureWaiter = () => Promise<void>;
type FlushScheduler = (flush: () => Promise<void>) => void;
type RpcRecord = Record<string, unknown>;
type CompactDeltaType = "text_delta" | "thinking_delta" | "toolcall_delta";

export const MAX_SHARED_STDIO_QUEUE_BYTES = 64 * 1024 * 1024;
export const MAX_SHARED_STDIO_QUEUE_RECORDS = 4096;

const MESSAGE_KEY = "message";
const COMPACT_DELTA_TYPES = new Set<CompactDeltaType>(["text_delta", "thinking_delta", "toolcall_delta"]);

function compactDelta(value: RpcRecord): { type: CompactDeltaType; contentIndex: number; delta: string } | undefined {
	if (value.type !== "message_update" || !Object.hasOwn(value, "message")) return undefined;
	const event = value.assistantMessageEvent;
	if (typeof event !== "object" || event === null) return undefined;
	const typedEvent = event as Record<string, unknown>;
	if (
		typeof typedEvent.type !== "string" ||
		!COMPACT_DELTA_TYPES.has(typedEvent.type as CompactDeltaType) ||
		typeof typedEvent.contentIndex !== "number" ||
		typeof typedEvent.delta !== "string"
	) {
		return undefined;
	}
	return {
		type: typedEvent.type as CompactDeltaType,
		contentIndex: typedEvent.contentIndex,
		delta: typedEvent.delta,
	};
}

/** The delta-only form of a compact message_update: cumulative snapshot fields blanked, delta kept. */
function demoteToDeltaOnly(value: RpcRecord): RpcRecord {
	const event = value.assistantMessageEvent as Record<string, unknown>;
	return { ...value, message: null, assistantMessageEvent: { ...event, partial: null } };
}

function toolUpdateKey(value: RpcRecord): string | undefined {
	return value.type === "tool_execution_update" && typeof value.toolCallId === "string"
		? `tool:${value.toolCallId}`
		: undefined;
}

/**
 * Process-wide stdout scheduler for multi-session RPC mode.
 *
 * Each queue contains complete structured JSONL records for one routing handle.
 * Draining takes one record per queue in round-robin order and waits for stdout
 * backpressure before selecting the next one. A record is deliberately written
 * by itself: coalescing records from different sessions would obscure the
 * scheduling boundary and violate D9.
 */
export class SessionEventWriter {
	readonly structuredLanes = new SessionStructuredLanes();
	private presenterAuthority?: McpPresenterAuthority;
	private readonly presenterConnections = new Map<string, McpPresenterConnection>();
	private readonly presenterBindings = new Map<string, McpFormBinding>();

	/** Deployment switch. Ordinary RPC behavior is unchanged unless the host explicitly enables it. */
	enableMcpPresenters(): McpPresenterAuthority {
		this.presenterAuthority ??= new McpPresenterAuthority();
		return this.presenterAuthority;
	}

	get mcpPresenters(): McpPresenterAuthority | undefined {
		return this.presenterAuthority;
	}

	getMcpPresenterConnection(id: string): McpPresenterConnection | undefined {
		return this.presenterConnections.get(id);
	}
	findMcpPresenterConnection(nonce: string): McpPresenterConnection | undefined {
		return [...this.presenterConnections.values()].find((connection) => connection.nonce === nonce);
	}

	getMcpFormBinding(sessionId: string): McpFormBinding | undefined {
		return this.presenterBindings.get(sessionId);
	}

	bindMcpForms(
		sessionId: string,
		durableId: string,
		ui: object,
		admit: () => void,
	): (() => void) | undefined | Promise<(() => void) | undefined> {
		const authority = this.presenterAuthority;
		if (!authority) return undefined;
		const binding = authority.bind(sessionId, durableId, admit);
		this.presenterBindings.set(sessionId, binding);
		for (const id of this.fanout.attachedConnections(sessionId)) {
			const connection = this.presenterConnections.get(id);
			if (connection) authority.attach(connection, binding);
		}
		bindPrivateMcpForms(ui, binding);
		return () => {
			binding.dispose();
			if (this.presenterBindings.get(sessionId) === binding) this.presenterBindings.delete(sessionId);
		};
	}

	/** Private records bypass event queues, snapshots, mirrors, replay, and overflow preview errors. */
	handleMcpForm(value: unknown): boolean {
		if (!this.presenterAuthority) return false;
		if (
			typeof value !== "object" ||
			value === null ||
			!("type" in value) ||
			typeof value.type !== "string" ||
			(!value.type.startsWith("mcp_form_") && value.type !== "mcp_presenter_context")
		)
			return false;
		const id = this.currentConnection();
		const sender = id === undefined ? undefined : this.presenterConnections.get(id);
		const context =
			value.type === "mcp_presenter_context" && "sessionId" in value && typeof value.sessionId === "string" && sender
				? this.presenterAuthority?.connectionContext(sender, value.sessionId)
				: undefined;
		const reply =
			value.type === "mcp_presenter_context"
				? context
					? { ok: true, context }
					: { error: "presenter_not_authorized" }
				: sender && this.presenterAuthority
					? this.presenterAuthority.receive(sender, value)
					: { error: "presenter_not_authorized" };
		const connection = id === undefined ? undefined : this.fanout.get(id)?.connection;
		if (connection) {
			try {
				connection.writeRaw(
					serializeJsonLine({
						type: "mcp_form_reply",
						...("id" in value && typeof value.id === "string" ? { id: value.id } : {}),
						...reply,
					}),
				);
			} catch {
				if (sender) this.presenterAuthority?.detach(sender);
			}
		}
		return true;
	}
	private readonly records = new SessionRecordAccounting();
	private readonly queues = new Map<string, RecordQueue>();
	private readonly fanout = new SessionEventFanout();
	readonly connectionContext = new SessionConnectionContext((id) => this.fanout.get(id)?.owner);
	private readonly securityPresentations = new RpcSecurityPresentations(
		this.fanout,
		(id, task) => this.withConnection(id, task),
		() => this.requestFlush(),
	);
	readonly workerSecurityBridge: boolean = false;
	private readonly controlQueue: RecordQueue = { latestByKey: new Map(), ready: false };
	private readonly readyQueues: RecordQueue[] = [];
	private readonly sealedSessions = new Set<string>();
	/** Sessions whose lifecycle records stay on their attached connections (`kind: "worker"`). */
	private readonly workerSessions = new Set<string>();
	private readonly openTurns = new SessionOpenTurns();
	/** Host-level `subscribe_sessions` subscriptions; publishes ride each subscriber's own FIFO actor. */
	readonly status = new SessionStatusStream({
		enqueue: (connectionId, line) => {
			const actor = this.fanout.get(connectionId)?.actor;
			if (actor === undefined) return false;
			actor.enqueue(line);
			this.requestFlush();
			return true;
		},
		pendingQuestions: (sessionId) => this.fanout.pendingQuestionCount(sessionId),
	});
	/** F13 surface dedupe: one notice per connection per inventory transition, tracked per session. */
	private readonly surfaceDedupe = new SurfaceDigestDedupe();
	/**
	 * Set by the host wiring: drains the session's pending effect transitions. Invoked after every
	 * record this writer publishes for the session, so an `effect_status` always lands after its cause.
	 */
	afterRecord?: (sessionId: string) => void;
	/** Per-session image persisters: bytes reach disk before the placeholder that names them is emitted. */
	private readonly mediaPersisters = new Map<string, MediaPersister>();
	private readonly writeRaw: RawWriter;
	private readonly waitForBackpressure?: BackpressureWaiter;
	private readonly scheduleFlush: FlushScheduler;
	private flushScheduled = false;
	private drainPromise?: Promise<void>;
	private inFlight?: { queue: RecordQueue; node: QueueNode };
	private failure?: unknown;
	private controlOverflowReported = false;
	private closeOverflowReported = false;
	private readonly closeOverflowActors = new WeakSet<SocketEventSinkActor>();
	private reservedCloseRecords = 0;
	private reservedCloseBytes = 0;

	get pendingCloseRecordCount(): number {
		return this.reservedCloseRecords;
	}

	get pendingCloseByteLength(): number {
		return this.reservedCloseBytes;
	}

	constructor(writeRaw: RawWriter, scheduleFlush?: FlushScheduler);
	constructor(writeRaw: RawWriter, waitForBackpressure: BackpressureWaiter, scheduleFlush?: FlushScheduler);
	constructor(
		writeRaw: RawWriter,
		waitOrSchedule?: BackpressureWaiter | FlushScheduler,
		scheduleFlush?: FlushScheduler,
	) {
		this.fanout.onConnectionClosed = (id) => {
			this.securityPresentations.dropConnection(id);
			const sender = this.presenterConnections.get(id);
			if (sender) this.presenterAuthority?.detach(sender);
			this.presenterConnections.delete(id);
		};
		this.writeRaw = writeRaw;
		if (waitOrSchedule && scheduleFlush === undefined && waitOrSchedule.length > 0) {
			this.scheduleFlush = waitOrSchedule as FlushScheduler;
		} else {
			this.waitForBackpressure = waitOrSchedule as BackpressureWaiter | undefined;
			this.scheduleFlush = scheduleFlush ?? ((flush) => queueMicrotask(() => void flush()));
		}
	}

	get bufferedRecordCount(): number {
		return this.records.count + (this.inFlight ? 1 : 0);
	}

	get bufferedByteLength(): number {
		return this.records.bytes + (this.inFlight?.node.byteLength ?? 0);
	}

	isSessionSealed(sessionId: string): boolean {
		return this.sealedSessions.has(sessionId);
	}

	registerConnection(
		id: string,
		connection: SessionEventWriterConnection,
		options: { readonly maxQueueBytes?: number; readonly stallMs?: number } = {},
	): void {
		const previousPresenter = this.presenterConnections.get(id);
		if (previousPresenter) this.presenterAuthority?.detach(previousPresenter);
		this.fanout.registerConnection(id, connection, options);
		if (this.presenterAuthority) {
			const sender = this.presenterAuthority.connect(id, (frame) => {
				if (!this.fanout.get(id)) return false;
				try {
					connection.writeRaw(serializeJsonLine(frame));
					// A pending drain does not undo an accepted write or drop the next resolution.
					void connection.waitForBackpressure().catch(() => this.presenterAuthority?.detach(sender));
					return true;
				} catch {
					this.presenterAuthority?.detach(sender);
					return false;
				}
			});
			this.presenterConnections.set(id, sender);
		}
	}

	unregisterConnection(id: string): void {
		const sender = this.presenterConnections.get(id);
		if (sender) this.presenterAuthority?.detach(sender);
		this.presenterConnections.delete(id);
		this.securityPresentations.dropConnection(id);
		this.fanout.unregisterConnection(id);
		this.status.dropConnection(id);
		this.surfaceDedupe.dropConnection(id);
	}

	attachConnectionToSession(id: string, sessionId: string): void {
		this.fanout.attachConnectionToSession(id, sessionId);
		if (this.hasConnection(id)) this.securityPresentations.attach(id, sessionId);
		const sender = this.presenterConnections.get(id);
		const binding = this.presenterBindings.get(sessionId);
		if (sender && binding) this.presenterAuthority?.attach(sender, binding);
	}

	detachConnectionFromSession(id: string, sessionId: string): void {
		const sender = this.presenterConnections.get(id);
		const binding = this.presenterBindings.get(sessionId);
		if (sender && binding) this.presenterAuthority?.detach(sender, binding);
		this.fanout.detachConnectionFromSession(id, sessionId);
		this.securityPresentations.detach(id, sessionId);
	}

	hasConnection(id: string): boolean {
		return this.fanout.get(id) !== undefined;
	}

	setConnectionCapabilities(id: string, capabilities: readonly string[]): void {
		this.fanout.setConnectionCapabilities(id, capabilities);
		this.securityPresentations.capabilitiesChanged(id);
		if (!capabilities.includes("interactive_user") || !capabilities.includes("mcp_form_presenter_v1")) {
			const sender = this.presenterConnections.get(id);
			if (sender) this.presenterAuthority?.withdraw(sender);
		}
	}

	clearConnectionCapabilities(id: string): void {
		const sender = this.presenterConnections.get(id);
		if (sender) this.presenterAuthority?.withdraw(sender);
		this.fanout.clearConnectionCapabilities(id);
		this.securityPresentations.capabilitiesChanged(id);
	}
	bindSecurityPresentations(
		sessionId: string,
		durableId: string,
		notices: SecurityNoticeSnapshot,
		ui: ExtensionUIContext,
	): (() => void) | undefined {
		if (this.fanout.isEmpty()) return undefined;
		return this.securityPresentations.bind(sessionId, durableId, notices, ui.select);
	}
	acceptWorkerSecuritySnapshot(sessionId: string, snapshot: SecurityNoticeState): void {
		this.securityPresentations.acceptSnapshot(sessionId, snapshot);
	}
	routeWorkerGrant(
		sessionId: string,
		requestId: string,
		preferred: string | undefined,
		capabilities: readonly string[],
		cancel: () => void,
	): { readonly accepted: boolean; readonly connection?: string } {
		return this.securityPresentations.routeWorkerGrant(sessionId, requestId, preferred, capabilities, cancel);
	}
	acceptWorkerGrantResponse(sessionId: string, id: string, connection: string | undefined): boolean | undefined {
		return this.securityPresentations.acceptWorkerResponse(sessionId, id, connection);
	}
	settleGrantDialog(sessionId: string, id: string): void {
		this.securityPresentations.settleGrant(sessionId, id);
	}

	hasRegisteredConnectionCapabilities(id: string): boolean {
		return this.fanout.hasRegisteredConnectionCapabilities(id);
	}

	getConnectionCapabilities(id: string): readonly string[] | undefined {
		return this.fanout.getConnectionCapabilities(id);
	}

	/**
	 * Records a session's visibility class. A worker session is machine-driven work that
	 * only its attached connections track, so its lifecycle records are delivered to them
	 * instead of broadcast; an interactive session keeps the broadcast every client (the
	 * desktop mirror, the supervisor's idle observer) relies on.
	 */
	setSessionMedia(sessionId: string, persister: MediaPersister | undefined): void {
		if (persister === undefined) this.mediaPersisters.delete(sessionId);
		else this.mediaPersisters.set(sessionId, persister);
	}

	/** The session's records reach `lane` before `enqueue`; sealing or forgetting the session retires it. */
	registerAcceptance(sessionId: string, lane: SessionAcceptanceLane): void {
		if (!this.sealedSessions.has(sessionId)) this.fanout.acceptance.set(sessionId, lane);
	}

	setSessionKind(sessionId: string, kind: SessionKind): void {
		if (kind === "worker") this.workerSessions.add(sessionId);
		else this.workerSessions.delete(sessionId);
	}

	/** Drain just this connection before closing it after its last handoff park. */
	async flushConnection(id: string): Promise<void> {
		const target = this.fanout.get(id);
		if (target) await settleActors([target.actor]);
	}

	/** Execute a connection's command with its response destination in context. */
	withConnection<T>(id: string, task: () => T): T {
		return this.connectionContext.run(id, task);
	}

	/** Connection id of the command currently being dispatched, when one owns it. */
	currentConnection(): string | undefined {
		return this.connectionContext.getStore();
	}

	/** Queue a session record. Content events target connections attached to the session. */
	enqueue(sessionId: string, value: object): boolean {
		if (this.sealedSessions.has(sessionId)) return false;
		const targetId = this.connectionContext.getStore();
		const record = normalizeJsonValue(value).value as RpcRecord;
		const isTargeted =
			record.type === "response" ||
			record.type === "bash_execution_update" ||
			// Relocation records belong to the one connection that offers it (session-relocation-channel.ts).
			record.type === "host_request" ||
			record.type === "relocation_due" ||
			(record.type === "extension_ui_request" &&
				["select", "confirm", "input", "editor"].includes(String(record.method)));
		// A stale reply is consumed, not a session failure: the worker still gets its output credit.
		const current = isTargeted ? this.connectionContext.currentGuard() : undefined;
		if (current?.() === false) return true;
		const tagged = { ...observeLifecycleDelivery(record), sessionId } as RpcRecord;
		const line = serializeJsonLine(tagged);
		// Observation records are per-subscription opt-ins on the subscriber's own actor FIFO: never attachments,
		// the attach replay, response broadcast, or the stdio lane, which cannot subscribe.
		if (
			record.type === "snapshot_marker" ||
			record.type === "ui_request_pending" ||
			record.type === "ui_request_settled"
		) {
			const targets =
				record.type === "snapshot_marker"
					? this.status.mirrorTargets(sessionId, "snapshot_marker").filter((id) => id === targetId)
					: this.status.dialogTargets(sessionId);
			for (const target of targets) this.fanout.get(target)?.actor.enqueue(line);
			if (targets.length > 0) this.requestFlush();
			return true;
		}
		if (this.fanout.isEmpty() && this.exceedsStdioCapacity(line)) {
			this.closeSession(
				sessionId,
				{
					type: "response",
					command: "close_session",
					success: false,
					error: "session_output_overflow, resync required",
				},
				"error",
			);
			return false;
		}
		this.openTurns.note(sessionId, record.type);
		const attached = this.fanout.targets(sessionId, targetId, isTargeted, record.type);
		// Mirroring is an explicit per-subscription opt-in; it adds destinations, never an attachment.
		const mirrors = isTargeted ? [] : this.status.mirrorTargets(sessionId, String(record.type));
		const targets = mirrors.length === 0 ? attached : [...new Set([...attached, ...mirrors])];
		// A record is only walked and re-serialized when a target asked for placeholders;
		// otherwise this is byte-for-byte today's path, with serializeJsonLine called once.
		const hasPlaceholderTarget = targets.some((target) =>
			this.fanout.connectionHas(target, MEDIA_PLACEHOLDERS_CAPABILITY),
		);
		const redacted = hasPlaceholderTarget
			? omitNormalInlineMedia(tagged, this.mediaPersisters.get(sessionId))
			: tagged;
		const placeholderLine = redacted === tagged ? undefined : serializeJsonLine(redacted);
		if (!isTargeted) this.fanout.rememberSnapshot(sessionId, tagged, line, placeholderLine);
		for (const target of targets) {
			if (target !== undefined && !this.fanout.get(target)) continue;
			const registered = target === undefined ? undefined : this.fanout.get(target);
			const wants =
				placeholderLine !== undefined && this.fanout.connectionHas(target, MEDIA_PLACEHOLDERS_CAPABILITY);
			if (registered) {
				const keyed = compactDelta(tagged) !== undefined && tagged.message !== null;
				registered.actor.enqueue(
					wants ? placeholderLine : line,
					keyed ? MESSAGE_KEY : undefined,
					undefined,
					keyed ? serializeJsonLine(demoteToDeltaOnly(tagged)) : undefined,
					isCorrelatedReply(tagged),
					current,
				);
			} else this.appendSessionRecord(sessionId, wants ? (redacted as RpcRecord) : tagged, target);
		}
		// After the causing record is on every destination's FIFO, never before (ordering contract).
		const cause = isTargeted ? undefined : causeOfRecord(record);
		if (cause !== undefined) this.status.publish(sessionId, cause, this.changeActor("agent"));
		this.afterRecord?.(sessionId);
		this.requestFlush();
		return true;
	}

	/** Who caused a change: the client whose command is being dispatched, else `fallback`. */
	private changeActor(fallback: SessionStatusActor): SessionStatusActor {
		return this.connectionContext.getStore() === undefined ? fallback : "client";
	}

	/**
	 * Publish `session_opened` for a session this host just created. Interactive sessions broadcast it (the
	 * lifecycle whitelist); a worker's reaches only its attached connections and subscribers that asked for
	 * workers (invariant I4). `context` travels only to subscribers that asked for it.
	 */
	publishSessionOpened(record: SessionOpenedRecord): void {
		if (this.fanout.isEmpty()) {
			const { context: _context, ...wire } = record;
			this.appendSessionRecord(record.sessionId, { ...wire });
			this.requestFlush();
			return;
		}
		const lines = sessionOpenedLines(record);
		const subscribers = this.status.matchingConnections(record.sessionId);
		const recipients =
			record.kind === "worker"
				? new Set([...this.fanout.attachedConnections(record.sessionId), ...subscribers.keys()])
				: new Set(this.fanout.connectionIds());
		for (const id of recipients)
			this.fanout.get(id)?.actor.enqueue(subscribers.get(id) === true ? lines.withContext : lines.plain);
		this.requestFlush();
	}

	/**
	 * One `loaded_surfaces_changed` per connection per inventory transition: sessions moving from the
	 * same digest to the same new one share a single event, tagged with the first session that
	 * reported it; a session converging from a different start still announces its own change.
	 */
	publishLoadedSurfacesChanged(sessionId: string, previous: string | undefined, digest: string): void {
		if (this.fanout.isEmpty()) {
			this.enqueue(sessionId, { type: "loaded_surfaces_changed" });
			return;
		}
		if (this.sealedSessions.has(sessionId)) return;
		const line = serializeJsonLine({ type: "loaded_surfaces_changed", sessionId });
		for (const id of this.fanout.attachedConnections(sessionId)) {
			if (!this.surfaceDedupe.announce(id, sessionId, previous, digest)) continue;
			this.fanout.get(id)?.actor.enqueue(line);
		}
		this.requestFlush();
	}

	/**
	 * Return worker credit once this session's destinations have ACCEPTED the record
	 * into their bounded queues - never when the slowest peer's kernel has drained it.
	 * A client that is merely busy would otherwise pace the producing worker into
	 * session_worker_credit_timeout and force the dead-peer budget under
	 * SESSION_WORKER_LIMITS.controlMs (#1774). Delivery stays bounded by each queue's
	 * maxQueueBytes and its dead-peer cut. A destination that failed (byte overflow or
	 * stall) was already cut and closed by the fanout's onFailure; it is a cut peer,
	 * not a writer failure. The shared stdio lane keeps its stdout backpressure wait.
	 */
	waitForSessionBackpressure(sessionId: string): Promise<void> {
		if (this.fanout.isEmpty()) return this.flush();
		return acceptActors(this.sessionActors(sessionId));
	}

	/** Registered actors this session's records are delivered to, plus the caller's own. */
	private sessionActors(sessionId: string): SocketEventSinkActor[] {
		const targets = new Set([
			...this.fanout.targets(sessionId, this.currentConnection(), false, undefined),
			this.currentConnection(),
		]);
		return [...targets].flatMap((target) => {
			const registered = target === undefined ? undefined : this.fanout.get(target);
			return registered ? [registered.actor] : [];
		});
	}

	/** Queue one untagged host-control response for the given connection (defaults to the current one). */
	enqueueControl(value: object, targetOverride?: string): Promise<void> {
		if (this.failure !== undefined) return Promise.reject(this.failure);
		const targetId = targetOverride ?? this.connectionContext.getStore();
		const registered = targetId === undefined ? undefined : this.fanout.get(targetId);
		if (registered) {
			registered.actor.enqueue(serializeJsonLine(value), undefined, undefined, undefined, isCorrelatedReply(value));
			this.requestFlush();
			return Promise.resolve();
		}
		if (this.exceedsStdioCapacity(serializeJsonLine(value))) {
			if (!this.controlOverflowReported) {
				this.controlOverflowReported = true;
				this.records.append(this.controlQueue, {
					type: "overflow",
					error: "rpc_control_output_overflow, resync required",
				});
				this.markReady(this.controlQueue);
				this.requestFlush();
			}
			return Promise.reject(new Error("rpc_control_output_overflow, resync required"));
		}
		const queue = targetId === undefined ? this.controlQueue : this.connectionQueue(targetId);
		const completion = new Promise<void>((resolve, reject) => {
			this.records.append(queue, { ...value }, undefined, resolve, reject);
		});
		this.markReady(queue);
		this.requestFlush();
		return completion;
	}

	/**
	 * Queue one HOST-level lifecycle record for every registered connection, or the
	 * shared stdio lane when none is registered. Unlike session records it is not tagged
	 * with a routing handle by the writer: `host_stalled` carries the handle it blames,
	 * and `host_memory_pressure` belongs to the process, not to a session.
	 */
	/**
	 * Tell ONE opener where it sits in the open queue, before its open reaches the loop.
	 *
	 * Sent to the opening connection only: a queue position is about that caller's request, not
	 * about the host. If the connection is gone the record is dropped rather than queued - a
	 * position is worthless to a client that already left.
	 */
	sendOpenQueued(connection: string, record: RpcOpenQueuedEvent): void {
		// Reconstruct so desktop `refresh-senpi-events.ts` sees a literal `type:` site in this file.
		const wire: RpcRecord = {
			type: "queued",
			for_request: record.for_request,
			position: record.position,
			in_flight: record.in_flight,
		};
		const target = this.fanout.get(connection);
		if (target === undefined) return;
		target.actor.enqueue(serializeJsonLine(wire));
		this.requestFlush();
	}

	broadcastHostRecord(record: RpcHostLifecycleEvent): void {
		// Reconstruct so desktop `refresh-senpi-events.ts` sees literal `type:` sites in this file.
		let wire: RpcRecord;
		switch (record.type) {
			case "host_superseded":
				wire = {
					type: "host_superseded",
					instanceId: record.instanceId,
					generation: record.generation,
					successor: record.successor,
				};
				break;
			case "host_stalled":
				wire = {
					type: "host_stalled",
					driftMs: record.driftMs,
					...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}),
					...(record.tool !== undefined ? { tool: record.tool } : {}),
				};
				break;
			case "host_memory_pressure":
				wire = {
					type: "host_memory_pressure",
					rssMb: record.rssMb,
					...(record.footprintMb !== undefined ? { footprintMb: record.footprintMb } : {}),
					...(record.measure !== undefined ? { measure: record.measure } : {}),
					sessions: record.sessions,
					...(record.main !== undefined ? { main: record.main } : {}),
					...(record.kernels !== undefined ? { kernels: record.kernels } : {}),
				};
				break;
			case "host_trimmed":
				wire = {
					type: "host_trimmed",
					footprintBeforeMb: record.footprintBeforeMb,
					footprintAfterMb: record.footprintAfterMb,
					measure: record.measure,
					collected: record.collected,
					sessions: record.sessions,
					pauseMs: record.pauseMs,
				};
				break;
			case "subscription_limits":
				wire = {
					type: "subscription_limits",
					provider: record.provider,
					account: record.account,
					windows: record.windows,
					reportedAt: record.reportedAt,
					...(record.plan === undefined ? {} : { plan: record.plan }),
					...(record.error === undefined ? {} : { error: record.error }),
				};
				break;
			default: {
				const exhaustive: never = record;
				throw new Error(`unexpected host record ${exhaustive}`);
			}
		}
		if (this.fanout.isEmpty()) {
			this.records.append(this.controlQueue, wire);
			this.markReady(this.controlQueue);
		} else this.fanout.broadcast(serializeJsonLine(wire));
		this.requestFlush();
	}

	/**
	 * Prevent subsequent records for a session and append its terminal response.
	 * Existing records retain FIFO order; this response is therefore that
	 * session's final stdout record.
	 */
	closeSession(sessionId: string, response: object, reason?: RpcSessionClosedReason, sessionPath?: string): void {
		this.presenterBindings.get(sessionId)?.dispose();
		this.presenterBindings.delete(sessionId);
		if (!this.settleBeforeSeal(sessionId)) return;
		this.sealedSessions.add(sessionId);
		this.securityPresentations.dropSession(sessionId);
		this.fanout.forgetSession(sessionId);
		this.mediaPersisters.delete(sessionId);
		const targetId = this.connectionContext.getStore();
		// `reason` tells an attached client WHY the handle ended, so a park it can reopen by path is
		// not read as a session that is gone. Absent unless the caller names one; clients tolerate that.
		const lifecycle: RpcSessionClosedEvent = {
			type: "session_closed",
			sessionId,
			...(reason && { reason }),
			...(sessionPath && { sessionPath }),
		};
		if (this.fanout.isEmpty()) this.appendSessionRecord(sessionId, lifecycle);
		else if (this.workerSessions.has(sessionId))
			this.fanout.deliverToSession(sessionId, serializeJsonLine(lifecycle));
		else this.fanout.broadcast(serializeJsonLine(lifecycle));
		this.sealStatus(sessionId, lifecycle);
		const taggedResponse = { ...response, sessionId };
		const registered = targetId === undefined ? undefined : this.fanout.get(targetId);
		if (registered)
			registered.actor.enqueue(
				serializeJsonLine(taggedResponse),
				undefined,
				undefined,
				undefined,
				isCorrelatedReply(response),
			);
		else this.appendSessionRecord(sessionId, taggedResponse, targetId);
		this.requestFlush();
	}

	/**
	 * Seal a session the host PARKED and publish `session_parked`.
	 *
	 * Parking is the idle sweep putting a RETAINED session back on disk: the routing
	 * handle ends exactly as a close ends it, but the session survives and reopens with
	 * `open_session { sessionPath }`, so the record a client dispatches on must say so
	 * instead of claiming the session ended. Delivery follows the `session_closed` rule -
	 * a worker session's record reaches only its attached connections, an interactive
	 * session's reaches every connection. No client asked for this teardown, so there is
	 * no close response to answer.
	 */
	parkSession(sessionId: string, sessionPath: string, reason: "idle" | "unloaded"): void {
		this.sealLifecycle(sessionId, { type: "session_parked", sessionId, sessionPath, reason });
	}

	/**
	 * Seal a session `release_session` handed to a runtime outside this host and publish
	 * `session_closed { reason: "released", sessionPath }`. Unlike a park the file must NOT be reopened
	 * here - another process now writes it. Delivered like a park; the releasing caller's own answer is
	 * the `release_session` response, so there is no close response either.
	 */
	releaseSession(sessionId: string, sessionPath: string): void {
		this.sealLifecycle(sessionId, { type: "session_closed", sessionId, reason: "released", sessionPath });
	}

	/**
	 * Seal a session whose open rolled back after `session_opened` was published, so subscribers get
	 * its terminal record. The opener's answer is its own failed `open_session`; like a park, no close
	 * response is owed to anyone.
	 */
	sealRolledBackOpen(sessionId: string, sessionPath: string | undefined): void {
		this.sealLifecycle(sessionId, {
			type: "session_closed",
			sessionId,
			reason: "error",
			...(sessionPath !== undefined && { sessionPath }),
		});
	}

	sealLifecycle(
		sessionId: string,
		lifecycle: RpcSessionParkedEvent | RpcSessionClosedEvent,
		attachedOnly = false,
	): void {
		this.presenterBindings.get(sessionId)?.dispose();
		this.presenterBindings.delete(sessionId);
		if (!this.settleBeforeSeal(sessionId)) return;
		this.sealedSessions.add(sessionId);
		this.securityPresentations.dropSession(sessionId);
		this.fanout.forgetSession(sessionId);
		this.mediaPersisters.delete(sessionId);
		if (this.fanout.isEmpty()) this.appendSessionRecord(sessionId, lifecycle);
		else if (attachedOnly || this.workerSessions.has(sessionId))
			this.fanout.deliverToSession(sessionId, serializeJsonLine(lifecycle));
		else this.fanout.broadcast(serializeJsonLine(lifecycle));
		this.sealStatus(sessionId, lifecycle);
		this.requestFlush();
	}

	private sealStatus(sessionId: string, lifecycle: RpcSessionParkedEvent | RpcSessionClosedEvent): void {
		const terminal = terminalOfLifecycle(lifecycle);
		const cause = causeOfRecord(lifecycle);
		if (terminal !== undefined && cause !== undefined)
			this.status.seal(sessionId, terminal, cause, this.changeActor("host"));
	}

	/**
	 * Admit reply debt before routing can mutate attachments or await finalization.
	 * Reserve the lifecycle as well: the claimant's role is not known yet. Rejected
	 * closes do not wait, retain their ids, or create per-request stderr output.
	 */
	reserveCloseResponse(
		sessionId: string,
		response: object,
		records = 2,
	): { release: () => void; complete: (terminal: boolean, reason?: RpcSessionClosedReason) => void } | undefined {
		const bytes =
			Buffer.byteLength(serializeJsonLine({ ...response, sessionId })) +
			(records === 2
				? Buffer.byteLength(serializeJsonLine({ type: "session_closed", sessionId, reason: "client_close" }))
				: 0);
		if (
			this.bufferedRecordCount + this.reservedCloseRecords + records > MAX_SHARED_STDIO_QUEUE_RECORDS ||
			this.bufferedByteLength + this.reservedCloseBytes + bytes > MAX_SHARED_STDIO_QUEUE_BYTES
		) {
			const overflow = {
				type: "overflow",
				command: "close_session",
				error: "rpc_close_output_overflow, resync required",
			};
			const targetId = this.currentConnection();
			if (targetId !== undefined) {
				const actor = this.fanout.get(targetId)?.actor;
				if (actor && !this.closeOverflowActors.has(actor)) {
					this.closeOverflowActors.add(actor);
					// One outstanding notice per sink, released only on consumption.
					// Actor identity isolates reconnects and does not retain dead sinks.
					actor.enqueue(serializeJsonLine(overflow), undefined, () => this.closeOverflowActors.delete(actor));
				}
			} else if (!this.closeOverflowReported) {
				this.closeOverflowReported = true;
				this.records.append(this.controlQueue, overflow);
				this.markReady(this.controlQueue);
				this.requestFlush();
			}
			return undefined;
		}
		this.reservedCloseRecords += records;
		this.reservedCloseBytes += bytes;
		let active = true;
		const release = () => {
			if (!active) return;
			active = false;
			this.reservedCloseRecords -= records;
			this.reservedCloseBytes -= bytes;
		};
		return {
			release,
			complete: (terminal, reason) => {
				if (!active) return;
				release();
				if (terminal && !this.sealedSessions.has(sessionId)) this.closeSession(sessionId, response, reason);
				else this.appendClosedResponse(sessionId, response);
			},
		};
	}

	/** Queue a joined close only after admitting its noncompactable reply. */
	enqueueClosedResponse(sessionId: string, response: object): void {
		this.reserveCloseResponse(sessionId, response, 1)?.complete(false);
	}

	private appendClosedResponse(sessionId: string, response: object): void {
		const targetId = this.connectionContext.getStore();
		const taggedResponse = { ...response, sessionId };
		const registered = targetId === undefined ? undefined : this.fanout.get(targetId);
		if (registered)
			registered.actor.enqueue(
				serializeJsonLine(taggedResponse),
				undefined,
				undefined,
				undefined,
				isCorrelatedReply(response),
			);
		else this.appendSessionRecord(sessionId, taggedResponse, targetId);
		this.requestFlush();
	}

	/**
	 * Publishes the settles a seal would strand (session-open-turns.ts) while the session can still write;
	 * false when the session is sealed already, or became sealed by a settle that overflowed the stdio lane.
	 */
	private settleBeforeSeal(sessionId: string): boolean {
		if (this.sealedSessions.has(sessionId)) return false;
		for (let owed = this.openTurns.take(sessionId); owed > 0; owed -= 1) {
			this.enqueue(sessionId, { type: "agent_settled", reason: "session_closed" });
		}
		return !this.sealedSessions.has(sessionId);
	}

	/**
	 * Drops per-session bookkeeping for a handle whose runtime is fully disposed.
	 * Routing handles are unique per process epoch, so nothing can legitimately
	 * emit under this id again; without this every host-closed session would
	 * leave a permanent sealed-handle (and snapshot) entry behind.
	 */
	forgetSession(sessionId: string): void {
		this.sealedSessions.delete(sessionId);
		this.openTurns.take(sessionId);
		this.workerSessions.delete(sessionId);
		this.fanout.forgetSession(sessionId);
		this.mediaPersisters.delete(sessionId);
		this.status.forget(sessionId);
		this.surfaceDedupe.forgetSession(sessionId);
	}

	/** Drain every retained lane and the current in-flight record. */
	flush(): Promise<void> {
		if (this.failure !== undefined) return Promise.reject(this.failure);
		this.flushScheduled = false;
		if (this.drainPromise) return this.drainPromise;
		if (this.readyQueues.length === 0) return settleActors([...this.fanout.values()].map(({ actor }) => actor));
		let resolveDrain!: () => void;
		let rejectDrain!: (cause: unknown) => void;
		const drain = new Promise<void>((resolve, reject) => {
			resolveDrain = resolve;
			rejectDrain = reject;
		});
		this.drainPromise = drain;
		void this.drainUntilEmpty().then(resolveDrain, rejectDrain);
		void drain.then(
			() => {
				if (this.drainPromise === drain) this.drainPromise = undefined;
				if (this.readyQueues.length > 0) this.requestFlush();
			},
			(cause) => {
				if (this.drainPromise === drain) this.drainPromise = undefined;
				this.fail(cause);
			},
		);
		return drain;
	}

	private async drainUntilEmpty(): Promise<void> {
		do {
			await this.drainReadyQueues();
		} while (this.readyQueues.length > 0);
		// Per-connection failures are handled by the fanout (cut + close); only the
		// shared stdio lane may fail this writer.
		await settleActors([...this.fanout.values()].map(({ actor }) => actor));
		this.controlOverflowReported = false;
		if (this.reservedCloseRecords === 0) this.closeOverflowReported = false;
	}

	private async drainReadyQueues(): Promise<void> {
		while (this.readyQueues.length > 0) {
			const queue = this.readyQueues.shift()!;
			queue.ready = false;
			const node = queue.head;
			if (!node) continue;

			this.records.unlink(queue, node);
			this.inFlight = { queue, node };
			try {
				// D9: exactly one complete record per raw write. The next lane is not
				// selected until this record has cleared stdout backpressure.
				const connection = queue.targetId ? this.fanout.get(queue.targetId)?.connection : undefined;
				const writeRaw = connection?.writeRaw ?? this.writeRaw;
				const waitForBackpressure = connection?.waitForBackpressure ?? this.waitForBackpressure;
				if (!connection && queue.targetId) {
					node.resolve?.();
				} else {
					writeRaw(node.line);
					if (waitForBackpressure) await waitForBackpressure();
					node.resolve?.();
				}
			} catch (cause) {
				node.reject?.(cause);
				throw cause;
			} finally {
				this.inFlight = undefined;
			}

			if (queue.head) {
				this.markReady(queue);
			} else if (queue.sessionId || queue.targetId) {
				for (const [key, candidate] of this.queues) {
					if (candidate === queue) this.queues.delete(key);
				}
			}
		}
	}

	private exceedsStdioCapacity(line: string): boolean {
		return (
			this.bufferedRecordCount + this.reservedCloseRecords >= MAX_SHARED_STDIO_QUEUE_RECORDS ||
			this.bufferedByteLength + this.reservedCloseBytes + Buffer.byteLength(line) > MAX_SHARED_STDIO_QUEUE_BYTES
		);
	}

	private connectionQueue(targetId: string): RecordQueue {
		const key = `connection:${targetId}`;
		let queue = this.queues.get(key);
		if (!queue) {
			queue = { targetId, latestByKey: new Map(), ready: false };
			this.queues.set(key, queue);
		}
		return queue;
	}

	private appendSessionRecord(sessionId: string, value: RpcRecord, targetId?: string): void {
		const key = `${targetId ?? "default"}:${sessionId}`;
		let queue = this.queues.get(key);
		if (!queue) {
			queue = { sessionId, targetId, latestByKey: new Map(), ready: false };
			this.queues.set(key, queue);
		}

		const delta = compactDelta(value);
		if (delta) {
			const previousFull = queue.latestByKey.get(MESSAGE_KEY);
			if (previousFull) this.demoteAndMerge(queue, previousFull);
			const node = this.records.append(queue, value, MESSAGE_KEY);
			queue.latestByKey.set(MESSAGE_KEY, node);
			this.markReady(queue);
			return;
		}

		const toolKey = toolUpdateKey(value);
		if (toolKey) {
			const previous = queue.latestByKey.get(toolKey);
			if (previous) this.records.unlink(queue, previous);
			const node = this.records.append(queue, value, toolKey);
			queue.latestByKey.set(toolKey, node);
			this.markReady(queue);
			return;
		}

		// All non-compactable records are ordering barriers. In particular this
		// includes delta-only/full non-delta message updates, protocol responses,
		// extension UI requests, errors, retries, lifecycle, and unknown records.
		queue.latestByKey.clear();
		this.records.append(queue, value);
		this.markReady(queue);
	}

	private demoteAndMerge(queue: RecordQueue, node: QueueNode): void {
		this.records.replace(node, demoteToDeltaOnly(node.value));
		const current = compactDelta(node.value);
		const preceding = node.previous;
		const previous = preceding ? compactDelta(preceding.value) : undefined;
		if (
			preceding &&
			previous &&
			current &&
			preceding.value.message === null &&
			previous.type === current.type &&
			previous.contentIndex === current.contentIndex
		) {
			const precedingEvent = preceding.value.assistantMessageEvent as Record<string, unknown>;
			this.records.replace(preceding, {
				...preceding.value,
				assistantMessageEvent: { ...precedingEvent, delta: previous.delta + current.delta },
			});
			this.records.unlink(queue, node);
		}
	}

	private markReady(queue: RecordQueue): void {
		if (queue.ready || this.inFlight?.queue === queue || !queue.head) return;
		queue.ready = true;
		this.readyQueues.push(queue);
	}

	private requestFlush(): void {
		if (this.failure !== undefined || this.flushScheduled || this.drainPromise) return;
		this.flushScheduled = true;
		this.scheduleFlush(() => this.flush());
	}

	private fail(cause: unknown): void {
		if (this.failure !== undefined) return;
		this.failure = cause;
		for (const queue of this.allQueues()) {
			for (let node = queue.head; node; node = node.next) node.reject?.(cause);
		}
	}

	private *allQueues(): Iterable<RecordQueue> {
		yield* this.queues.values();
		yield this.controlQueue;
	}
}
