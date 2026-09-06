import { AsyncLocalStorage } from "node:async_hooks";
import { MEDIA_PLACEHOLDERS_CAPABILITY } from "./custom-capability.ts";
import { serializeJsonLine } from "./jsonl.ts";
import { omitInlineMedia } from "./media-placeholders.ts";
import {
	RENDERED_COMPONENT_RECORD,
	SessionEventFanout,
	type SessionEventWriterConnection,
} from "./session-event-fanout.ts";

export { RENDERED_COMPONENT_RECORD, type SessionEventWriterConnection } from "./session-event-fanout.ts";

type RawWriter = (chunk: string) => void;
type BackpressureWaiter = () => Promise<void>;
type FlushScheduler = (flush: () => Promise<void>) => void;
type RpcRecord = Record<string, unknown>;
type CompactDeltaType = "text_delta" | "thinking_delta" | "toolcall_delta";

type QueueNode = {
	value: RpcRecord;
	key?: string;
	previous?: QueueNode;
	next?: QueueNode;
	resolve?: () => void;
	reject?: (cause: unknown) => void;
};

type RecordQueue = {
	sessionId?: string;
	targetId?: string;
	head?: QueueNode;
	tail?: QueueNode;
	latestByKey: Map<string, QueueNode>;
	ready: boolean;
};

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
	private readonly queues = new Map<string, RecordQueue>();
	private readonly fanout = new SessionEventFanout();
	private readonly connectionContext = new AsyncLocalStorage<string>();
	private readonly controlQueue: RecordQueue = { latestByKey: new Map(), ready: false };
	private readonly readyQueues: RecordQueue[] = [];
	private readonly sealedSessions = new Set<string>();
	private readonly writeRaw: RawWriter;
	private readonly waitForBackpressure?: BackpressureWaiter;
	private readonly scheduleFlush: FlushScheduler;
	private flushScheduled = false;
	private drainPromise?: Promise<void>;
	private inFlight?: { queue: RecordQueue; node: QueueNode };
	private failure?: unknown;

	constructor(writeRaw: RawWriter, scheduleFlush?: FlushScheduler);
	constructor(writeRaw: RawWriter, waitForBackpressure: BackpressureWaiter, scheduleFlush?: FlushScheduler);
	constructor(
		writeRaw: RawWriter,
		waitOrSchedule?: BackpressureWaiter | FlushScheduler,
		scheduleFlush?: FlushScheduler,
	) {
		this.writeRaw = writeRaw;
		if (waitOrSchedule && scheduleFlush === undefined && waitOrSchedule.length > 0) {
			this.scheduleFlush = waitOrSchedule as FlushScheduler;
		} else {
			this.waitForBackpressure = waitOrSchedule as BackpressureWaiter | undefined;
			this.scheduleFlush = scheduleFlush ?? ((flush) => queueMicrotask(() => void flush()));
		}
	}

	get bufferedRecordCount(): number {
		let count = this.inFlight ? 1 : 0;
		for (const queue of this.allQueues()) {
			for (let node = queue.head; node; node = node.next) count++;
		}
		return count;
	}

	get bufferedByteLength(): number {
		let bytes = this.inFlight ? Buffer.byteLength(serializeJsonLine(this.inFlight.node.value)) : 0;
		for (const queue of this.allQueues()) {
			for (let node = queue.head; node; node = node.next) {
				bytes += Buffer.byteLength(serializeJsonLine(node.value));
			}
		}
		return bytes;
	}

	registerConnection(
		id: string,
		connection: SessionEventWriterConnection,
		options: { readonly maxQueueBytes?: number } = {},
	): void {
		this.fanout.registerConnection(id, connection, options);
	}

	unregisterConnection(id: string): void {
		this.fanout.unregisterConnection(id);
	}

	attachConnectionToSession(id: string, sessionId: string): void {
		this.fanout.attachConnectionToSession(id, sessionId);
	}

	detachConnectionFromSession(id: string, sessionId: string): void {
		this.fanout.detachConnectionFromSession(id, sessionId);
	}

	setConnectionCapabilities(id: string, capabilities: readonly string[]): void {
		this.fanout.setConnectionCapabilities(id, capabilities);
	}

	clearConnectionCapabilities(id: string): void {
		this.fanout.clearConnectionCapabilities(id);
	}

	hasRegisteredConnectionCapabilities(id: string): boolean {
		return this.fanout.hasRegisteredConnectionCapabilities(id);
	}

	getConnectionCapabilities(id: string): readonly string[] | undefined {
		return this.fanout.getConnectionCapabilities(id);
	}

	hasCapableConnection(sessionId: string): boolean {
		return this.fanout.hasCapableConnection(sessionId);
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
		const record = value as RpcRecord;
		const isTargeted =
			record.type === "response" ||
			record.type === "bash_execution_update" ||
			(record.type === "extension_ui_request" &&
				["select", "confirm", "input", "editor"].includes(String(record.method)));
		const tagged = { ...value, sessionId } as RpcRecord;
		const { [RENDERED_COMPONENT_RECORD]: _rendered, ...wireTagged } = tagged;
		const line = serializeJsonLine(wireTagged);
		const targets = this.fanout.targets(
			sessionId,
			targetId,
			isTargeted,
			record[RENDERED_COMPONENT_RECORD] === true,
			record.type,
		);
		// A record is only walked and re-serialized when a target asked for placeholders;
		// otherwise this is byte-for-byte today's path, with serializeJsonLine called once.
		const hasPlaceholderTarget = targets.some((target) =>
			this.fanout.connectionHas(target, MEDIA_PLACEHOLDERS_CAPABILITY),
		);
		const redacted = hasPlaceholderTarget ? omitInlineMedia(wireTagged) : wireTagged;
		const placeholderLine = redacted === wireTagged ? undefined : serializeJsonLine(redacted);
		if (!isTargeted) this.fanout.rememberSnapshot(sessionId, tagged, line, placeholderLine, wireTagged);
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
					keyed ? serializeJsonLine(demoteToDeltaOnly(wireTagged)) : undefined,
				);
			} else this.appendSessionRecord(sessionId, wants ? (redacted as RpcRecord) : wireTagged, target);
		}
		this.requestFlush();
		return true;
	}

	/** Queue one untagged host-control response for the current connection. */
	enqueueControl(value: object): Promise<void> {
		if (this.failure !== undefined) return Promise.reject(this.failure);
		const targetId = this.connectionContext.getStore();
		const registered = targetId === undefined ? undefined : this.fanout.get(targetId);
		if (registered) {
			registered.actor.enqueue(serializeJsonLine(value));
			return Promise.resolve();
		}
		const queue = targetId === undefined ? this.controlQueue : this.connectionQueue(targetId);
		const completion = new Promise<void>((resolve, reject) => {
			this.append(queue, { ...value }, undefined, resolve, reject);
		});
		this.markReady(queue);
		this.requestFlush();
		return completion;
	}

	/**
	 * Prevent subsequent records for a session and append its terminal response.
	 * Existing records retain FIFO order; this response is therefore that
	 * session's final stdout record.
	 */
	closeSession(sessionId: string, response: object): void {
		if (this.sealedSessions.has(sessionId)) return;
		this.sealedSessions.add(sessionId);
		const targetId = this.connectionContext.getStore();
		const lifecycle = { type: "session_closed", sessionId };
		if (this.fanout.isEmpty()) this.appendSessionRecord(sessionId, lifecycle);
		else this.fanout.broadcast(serializeJsonLine(lifecycle));
		const taggedResponse = { ...response, sessionId };
		const registered = targetId === undefined ? undefined : this.fanout.get(targetId);
		if (registered) registered.actor.enqueue(serializeJsonLine(taggedResponse));
		else this.appendSessionRecord(sessionId, taggedResponse, targetId);
		this.requestFlush();
	}

	/** Queue a successful response for a joined close after the terminal lifecycle record. */
	enqueueClosedResponse(sessionId: string, response: object): void {
		const targetId = this.connectionContext.getStore();
		const taggedResponse = { ...response, sessionId };
		const registered = targetId === undefined ? undefined : this.fanout.get(targetId);
		if (registered) registered.actor.enqueue(serializeJsonLine(taggedResponse));
		else this.appendSessionRecord(sessionId, taggedResponse, targetId);
		this.requestFlush();
	}

	/**
	 * Drops per-session bookkeeping for a handle whose runtime is fully disposed.
	 * Routing handles are unique per process epoch, so nothing can legitimately
	 * emit under this id again; without this every host-closed session would
	 * leave a permanent sealed-handle (and snapshot) entry behind.
	 */
	forgetSession(sessionId: string): void {
		this.sealedSessions.delete(sessionId);
		this.fanout.forgetSession(sessionId);
	}

	/** Drain every retained lane and the current in-flight record. */
	flush(): Promise<void> {
		if (this.failure !== undefined) return Promise.reject(this.failure);
		this.flushScheduled = false;
		if (this.drainPromise) return this.drainPromise;
		if (this.readyQueues.length === 0)
			return Promise.all([...this.fanout.values()].map(({ actor }) => actor.flush())).then(() => undefined);
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
		await Promise.all([...this.fanout.values()].map(({ actor }) => actor.flush()));
	}

	private async drainReadyQueues(): Promise<void> {
		while (this.readyQueues.length > 0) {
			const queue = this.readyQueues.shift()!;
			queue.ready = false;
			const node = queue.head;
			if (!node) continue;

			this.unlink(queue, node);
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
					writeRaw(serializeJsonLine(node.value));
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
			const node = this.append(queue, value, MESSAGE_KEY);
			queue.latestByKey.set(MESSAGE_KEY, node);
			this.markReady(queue);
			return;
		}

		const toolKey = toolUpdateKey(value);
		if (toolKey) {
			const previous = queue.latestByKey.get(toolKey);
			if (previous) this.unlink(queue, previous);
			const node = this.append(queue, value, toolKey);
			queue.latestByKey.set(toolKey, node);
			this.markReady(queue);
			return;
		}

		// All non-compactable records are ordering barriers. In particular this
		// includes delta-only/full non-delta message updates, protocol responses,
		// extension UI requests, errors, retries, lifecycle, and unknown records.
		queue.latestByKey.clear();
		this.append(queue, value);
		this.markReady(queue);
	}

	private demoteAndMerge(queue: RecordQueue, node: QueueNode): void {
		node.value = demoteToDeltaOnly(node.value);
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
			preceding.value = {
				...preceding.value,
				assistantMessageEvent: { ...precedingEvent, delta: previous.delta + current.delta },
			};
			this.unlink(queue, node);
		}
	}

	private append(
		queue: RecordQueue,
		value: RpcRecord,
		key?: string,
		resolve?: () => void,
		reject?: (cause: unknown) => void,
	): QueueNode {
		const node: QueueNode = { value, key, previous: queue.tail, resolve, reject };
		if (queue.tail) queue.tail.next = node;
		else queue.head = node;
		queue.tail = node;
		return node;
	}

	private unlink(queue: RecordQueue, node: QueueNode): void {
		if (node.previous) node.previous.next = node.next;
		else queue.head = node.next;
		if (node.next) node.next.previous = node.previous;
		else queue.tail = node.previous;
		if (node.key && queue.latestByKey.get(node.key) === node) queue.latestByKey.delete(node.key);
		node.previous = undefined;
		node.next = undefined;
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
