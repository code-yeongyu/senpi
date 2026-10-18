/**
 * The cursor-based event feed a control client `subscribe`s to: state changes, assistant reports,
 * question changes and turn completions, numbered by one sequence. A client that reconnects with the
 * last `seq` it saw is replayed what the bounded ring still holds after it.
 */

export type ControlFeedKind = "state" | "report" | "question" | "completion";

export interface ControlFeedEvent {
	readonly type: "session_control_event";
	readonly seq: number;
	readonly kind: ControlFeedKind;
	readonly data: Readonly<Record<string, unknown>>;
}

const FEED_RING_SIZE = 256;

export class ControlFeed {
	private seq = 0;
	private stateVersionValue = 0;
	private readonly ring: ControlFeedEvent[] = [];
	private readonly subscribers = new Map<number, (event: ControlFeedEvent) => void>();

	get stateVersion(): number {
		return this.stateVersionValue;
	}

	publish(kind: ControlFeedKind, data: Readonly<Record<string, unknown>> = {}): void {
		if (kind === "state") this.stateVersionValue += 1;
		const event: ControlFeedEvent = {
			type: "session_control_event",
			seq: ++this.seq,
			kind,
			data: kind === "state" ? { ...data, state_version: this.stateVersionValue } : data,
		};
		this.ring.push(event);
		if (this.ring.length > FEED_RING_SIZE) this.ring.shift();
		for (const send of this.subscribers.values()) send(event);
	}

	subscribe(connection: number, cursor: number | undefined, send: (event: ControlFeedEvent) => void): number {
		this.subscribers.set(connection, send);
		if (cursor !== undefined) for (const event of this.ring) if (event.seq > cursor) send(event);
		return this.seq;
	}

	unsubscribe(connection: number): void {
		this.subscribers.delete(connection);
	}

	clear(): void {
		this.subscribers.clear();
	}
}
