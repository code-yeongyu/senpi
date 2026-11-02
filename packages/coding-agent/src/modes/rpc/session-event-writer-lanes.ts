import type { QueueNode, RecordQueue } from "./session-record-accounting.ts";
import {
	compactDelta,
	demoteToDeltaOnly,
	MESSAGE_KEY,
	type RpcRecord,
	toolUpdateKey,
} from "./session-event-writer-compaction.ts";
import { SessionEventWriterState } from "./session-event-writer-state.ts";
import type { SocketEventSinkActor } from "./socket-event-fanout.ts";

/** Await every actor's drain; a failed actor is a cut peer, not a writer failure. */
export const settleActors = (actors: readonly SocketEventSinkActor[]): Promise<void> =>
	Promise.all(actors.map((actor) => actor.flush().catch(() => undefined))).then(() => undefined);

/** Await every actor's ACCEPTANCE of what it was given; never the peer's kernel drain. */
export const acceptActors = (actors: readonly SocketEventSinkActor[]): Promise<void> =>
	Promise.all(actors.map((actor) => actor.waitForAcceptance())).then(() => undefined);

export const MAX_SHARED_STDIO_QUEUE_BYTES = 64 * 1024 * 1024;
export const MAX_SHARED_STDIO_QUEUE_RECORDS = 4096;

/** The shared stdio lane: per-handle record queues drained round-robin under stdout backpressure (D9). */
export abstract class SessionEventWriterLanes extends SessionEventWriterState {
	get bufferedRecordCount(): number {
		return this.records.count + (this.inFlight ? 1 : 0);
	}

	get bufferedByteLength(): number {
		return this.records.bytes + (this.inFlight?.node.byteLength ?? 0);
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

	protected exceedsStdioCapacity(line: string): boolean {
		return (
			this.bufferedRecordCount + this.reservedCloseRecords >= MAX_SHARED_STDIO_QUEUE_RECORDS ||
			this.bufferedByteLength + this.reservedCloseBytes + Buffer.byteLength(line) > MAX_SHARED_STDIO_QUEUE_BYTES
		);
	}

	protected connectionQueue(targetId: string): RecordQueue {
		const key = `connection:${targetId}`;
		let queue = this.queues.get(key);
		if (!queue) {
			queue = { targetId, latestByKey: new Map(), ready: false };
			this.queues.set(key, queue);
		}
		return queue;
	}

	protected appendSessionRecord(sessionId: string, value: RpcRecord, targetId?: string): void {
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

	protected markReady(queue: RecordQueue): void {
		if (queue.ready || this.inFlight?.queue === queue || !queue.head) return;
		queue.ready = true;
		this.readyQueues.push(queue);
	}

	protected requestFlush(): void {
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
