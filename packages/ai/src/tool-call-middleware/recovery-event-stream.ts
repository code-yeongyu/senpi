import type { AssistantMessageEvent } from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { snapshotRecoveryEvent } from "./recovery-message-snapshot.ts";

type CancellationHandler = () => void | Promise<void>;

/** Recovery events carry immutable snapshots and one awaitable cancellation lifecycle. */
export class RecoveryAssistantMessageEventStream extends AssistantMessageEventStream {
	private cancellationHandler: CancellationHandler | undefined;
	private cancellationPromise: Promise<void> | undefined;
	private sourceClosed = false;

	setCancellationHandler(handler: CancellationHandler): void {
		this.cancellationHandler = handler;
	}

	markSourceClosed(): boolean {
		if (this.cancellationPromise) return false;
		this.sourceClosed = true;
		return true;
	}

	override push(event: AssistantMessageEvent): void {
		super.push(snapshotRecoveryEvent(event));
	}

	override [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
		const iterator = super[Symbol.asyncIterator]();
		return {
			next: () => iterator.next(),
			return: async () => {
				if (!this.sourceClosed) {
					this.cancellationPromise ??= (async () => {
						await this.cancellationHandler?.();
					})();
					await this.cancellationPromise;
				}
				return { value: undefined, done: true };
			},
		};
	}
}
