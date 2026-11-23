import type { EvalDetachedCellNotifier, EvalDetachedCellSnapshot } from "./detached-cell-manager.ts";
import { buildDetachedCellNotification } from "./detached-cell-notification.ts";

export interface PendingDetachedNotification {
	readonly snapshot: () => EvalDetachedCellSnapshot | Promise<EvalDetachedCellSnapshot>;
	/**
	 * Resolves once the cell's own result is final (its write hooks returned). The notification joins a batch only then,
	 * so one cell's slow hook never holds back another cell's notification. If it rejects, the notification is still
	 * delivered, with the result the cell has.
	 */
	readonly ready?: Promise<void>;
}

interface QueuedNotification {
	readonly snapshot: PendingDetachedNotification["snapshot"];
	readonly release?: () => void;
}

export class DetachedNotificationQueue {
	readonly #notifier: EvalDetachedCellNotifier | undefined;
	readonly #holdWhileSettling: (() => () => void) | undefined;
	#pending: QueuedNotification[] = [];
	readonly #waiting = new Set<Promise<void>>();
	#flush: Promise<void> | undefined;

	constructor(notifier: EvalDetachedCellNotifier | undefined, holdWhileSettling?: () => () => void) {
		this.#notifier = notifier;
		this.#holdWhileSettling = holdWhileSettling;
	}

	enqueue(notification: PendingDetachedNotification): void {
		const { ready, snapshot } = notification;
		if (ready === undefined) {
			this.#push({ snapshot });
			return;
		}
		const release = this.#holdWhileSettling?.();
		const deliver = () => {
			this.#waiting.delete(waiting);
			this.#push(release === undefined ? { snapshot } : { snapshot, release });
		};
		const waiting = ready.then(deliver, deliver);
		this.#waiting.add(waiting);
	}

	/** Resolves once every notification enqueued so far was delivered, including those still waiting to be ready. */
	async flush(): Promise<void> {
		while (this.#waiting.size > 0) await Promise.all(this.#waiting);
		const flush = this.#flush;
		if (flush !== undefined) await flush;
	}

	#push(notification: QueuedNotification): void {
		this.#pending.push(notification);
		this.#schedule();
	}

	#schedule(): void {
		if (this.#flush !== undefined) return;
		const flush = Promise.resolve().then(async () => {
			const pending = this.#pending.splice(0);
			try {
				const notifications = await Promise.all(
					pending.map(async (item) => buildDetachedCellNotification(await item.snapshot())),
				);
				this.#notifier?.notify(notifications);
			} finally {
				for (const item of pending) item.release?.();
			}
		});
		this.#flush = flush;
		void flush.then(
			() => this.#finish(flush),
			() => this.#finish(flush),
		);
	}

	#finish(flush: Promise<void>): void {
		if (this.#flush !== flush) return;
		this.#flush = undefined;
		if (this.#pending.length > 0) this.#schedule();
	}
}
