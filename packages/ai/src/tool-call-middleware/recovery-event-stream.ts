import type { AssistantMessageEvent } from "../types.ts";
import {
	type CaptureHint,
	carryAssistantCapture,
	getAssistantCapture,
	setAssistantReader,
} from "../utils/assistant-capture.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { snapshotRecoveryEvent } from "./recovery-message-snapshot.ts";

type CancellationHandler = () => void | Promise<void>;

/** Recovery events carry immutable snapshots and one awaitable cancellation lifecycle. */
export class RecoveryAssistantMessageEventStream extends AssistantMessageEventStream {
	private cancellationHandler: CancellationHandler | undefined;
	private cancellationPromise: Promise<void> | undefined;
	private sourceClosed = false;
	private relaySource: AssistantMessageEvent | undefined;
	private relayed = false;

	constructor() {
		super({ captureBlocks: true });
		setAssistantReader(this, (project) => this.withCancellation(this.mapIterator(project)));
	}

	setCancellationHandler(handler: CancellationHandler): void {
		this.cancellationHandler = handler;
	}

	markSourceClosed(): boolean {
		if (this.cancellationPromise) return false;
		this.sourceClosed = true;
		return true;
	}

	/**
	 * Runs a projection step that copies `source` 1:1 to a new index. The copy is built from source blocks read after
	 * later deltas landed, so its capture relays the source's emission-time record instead of freezing the copy. Only
	 * the step's first push of the source's type is that copy; any later one records nothing.
	 */
	relaying<T>(source: AssistantMessageEvent, project: () => T): T {
		this.relaySource = source;
		this.relayed = false;
		try {
			return project();
		} finally {
			this.relaySource = undefined;
		}
	}

	override push(event: AssistantMessageEvent, hint?: CaptureHint): void {
		const source = this.relaySource;
		let relay = hint;
		if (source?.type === event.type) {
			relay = { ...hint, carried: this.relayed ? null : (getAssistantCapture(source) ?? null) };
			this.relayed = true;
		}
		super.push(carryAssistantCapture(event, snapshotRecoveryEvent(event)), relay);
	}

	override [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
		return this.withCancellation(super[Symbol.asyncIterator]());
	}

	private withCancellation<T>(iterator: AsyncIterator<T>): AsyncIterator<T> {
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
