import type { EvalDetachedCellNotifier, EvalDetachedCellSnapshot } from "./detached-cell-manager.ts";
import { buildDetachedCellNotification } from "./detached-cell-notification.ts";

export interface PendingDetachedNotification {
	readonly snapshot: () => EvalDetachedCellSnapshot;
	readonly spillPath: string | undefined;
}

export class DetachedNotificationQueue {
	readonly #artifactsDir: string | undefined;
	readonly #notifier: EvalDetachedCellNotifier | undefined;
	#pending: PendingDetachedNotification[] = [];
	#flush: Promise<void> | undefined;

	constructor(notifier: EvalDetachedCellNotifier | undefined, artifactsDir: string | undefined) {
		this.#notifier = notifier;
		this.#artifactsDir = artifactsDir;
	}

	enqueue(notification: PendingDetachedNotification): void {
		this.#pending.push(notification);
		this.#schedule();
	}

	async flush(): Promise<void> {
		const flush = this.#flush;
		if (flush !== undefined) await flush;
	}

	#schedule(): void {
		if (this.#flush !== undefined) return;
		const flush = Promise.resolve().then(async () => {
			const pending = this.#pending.splice(0);
			const notifications = await Promise.all(
				pending.map(
					async (item) => await buildDetachedCellNotification(item.snapshot(), item.spillPath, this.#artifactsDir),
				),
			);
			this.#notifier?.notify(notifications);
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
