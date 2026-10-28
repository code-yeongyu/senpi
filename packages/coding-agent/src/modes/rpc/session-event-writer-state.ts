import { AsyncLocalStorage } from "node:async_hooks";
import type { McpFormBinding } from "../../core/mcp-form-types.ts";
import type { McpPresenterAuthority, McpPresenterConnection } from "./mcp-presenter-authority.ts";
import { LegacyRecordRefusals } from "./legacy-record-depth.ts";
import type { MediaPersister } from "./media-placeholders.ts";
import { RpcSecurityPresentations } from "./security-presentations.ts";
import { SessionEventFanout } from "./session-event-fanout.ts";
import { SessionOpenTurns } from "./session-open-turns.ts";
import { type QueueNode, type RecordQueue, SessionRecordAccounting } from "./session-record-accounting.ts";
import { SessionStatusStream } from "./session-status-stream.ts";
import { SessionStructuredLanes } from "./session-structured-lanes.ts";
import { SurfaceDigestDedupe } from "./session-surface-dedupe.ts";
import type { SocketEventSinkActor } from "./socket-event-fanout.ts";

export type RawWriter = (chunk: string) => void;
export type BackpressureWaiter = () => Promise<void>;
export type FlushScheduler = (flush: () => Promise<void>) => void;

/**
 * Every field of the session event writer, in its original declaration order, and its constructor.
 * The writer's behaviour is split across the layers that extend this one (session-event-writer.ts).
 */
export abstract class SessionEventWriterState {
	readonly structuredLanes = new SessionStructuredLanes();
	/** Records refused at the engine's JSON depth limit on the legacy wire (RULING-68). */
	readonly legacyRefusals = new LegacyRecordRefusals();
	protected presenterAuthority?: McpPresenterAuthority;
	protected readonly presenterConnections = new Map<string, McpPresenterConnection>();
	protected readonly presenterBindings = new Map<string, McpFormBinding>();
	protected readonly records = new SessionRecordAccounting();
	protected readonly queues = new Map<string, RecordQueue>();
	protected readonly fanout = new SessionEventFanout();
	protected readonly connectionContext = new AsyncLocalStorage<string>();
	protected readonly securityPresentations = new RpcSecurityPresentations(
		this.fanout,
		(id, task) => this.withConnection(id, task),
		() => this.requestFlush(),
	);
	readonly workerSecurityBridge: boolean = false;
	protected readonly controlQueue: RecordQueue = { latestByKey: new Map(), ready: false };
	protected readonly readyQueues: RecordQueue[] = [];
	protected readonly sealedSessions = new Set<string>();
	/** Sessions whose lifecycle records stay on their attached connections (`kind: "worker"`). */
	protected readonly workerSessions = new Set<string>();
	protected readonly openTurns = new SessionOpenTurns();
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
	protected readonly surfaceDedupe = new SurfaceDigestDedupe();
	/**
	 * Set by the host wiring: drains the session's pending effect transitions. Invoked after every
	 * record this writer publishes for the session, so an `effect_status` always lands after its cause.
	 */
	afterRecord?: (sessionId: string) => void;
	/** Per-session image persisters: bytes reach disk before the placeholder that names them is emitted. */
	protected readonly mediaPersisters = new Map<string, MediaPersister>();
	protected readonly writeRaw: RawWriter;
	protected readonly waitForBackpressure?: BackpressureWaiter;
	protected readonly scheduleFlush: FlushScheduler;
	protected flushScheduled = false;
	protected drainPromise?: Promise<void>;
	protected inFlight?: { queue: RecordQueue; node: QueueNode };
	protected failure?: unknown;
	protected controlOverflowReported = false;
	protected closeOverflowReported = false;
	protected readonly closeOverflowActors = new WeakSet<SocketEventSinkActor>();
	protected reservedCloseRecords = 0;
	protected reservedCloseBytes = 0;

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

	abstract withConnection<T>(id: string, task: () => T): T;

	protected abstract requestFlush(): void;
}
