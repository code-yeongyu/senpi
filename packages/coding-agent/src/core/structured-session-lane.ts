import type { InternalAgentChannel } from "@earendil-works/pi-agent-core";
import { type AssistantProgress, carryAssistantCapture } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "./agent-session.ts";

/** One record of a session's internal structured lane: a session event or a block control, in session order. */
export type AgentSessionStructuredRecord = AgentSessionEvent | AssistantProgress;
type StructuredListener = (record: AgentSessionStructuredRecord) => void;

export class StructuredLaneUnavailableError extends Error {
	constructor() {
		super("Structured lane unavailable: Agent was constructed outside the session layer");
		this.name = "StructuredLaneUnavailableError";
	}
}

/**
 * The AgentSession end of the internal-only agent channel (senpi#4272, R3.C6.2). While a structured listener is
 * attached, it holds the channel's capture subscription; block controls enter the session's own event queue, so they
 * keep their position among the ordinary events. Extension listeners, `session.subscribe` and every legacy
 * destination never see a control.
 *
 * The capture subscription is module-wide (`subscribeAssistantCapture`): while it is held, every capture-enabled
 * provider stream in the process that first pushes afterwards builds capture records, including streams of sessions
 * with no structured listener, which drop them at their public iterator.
 */
export class StructuredSessionLane {
	private readonly listeners = new Set<StructuredListener>();
	readonly #channel: InternalAgentChannel | undefined;
	readonly #enqueue: (deliver: () => void) => void;
	private releaseChannel: (() => void) | undefined;

	constructor(channel: InternalAgentChannel | undefined, enqueue: (deliver: () => void) => void) {
		this.#channel = channel;
		this.#enqueue = enqueue;
	}

	get active(): boolean {
		return this.listeners.size > 0;
	}

	subscribe(listener: StructuredListener): () => void {
		if (!this.#channel) throw new StructuredLaneUnavailableError();
		this.listeners.add(listener);
		this.releaseChannel ??= this.#channel.subscribe((record) => {
			if ("progress" in record) this.#enqueue(() => this.emit(record.progress));
		});
		return () => {
			this.listeners.delete(listener);
			if (this.listeners.size === 0) this.dispose();
		};
	}

	/** Publishes a session event with the provider capture of its `source` agent event. */
	emitEvent(event: AgentSessionEvent, source: object): void {
		const message =
			(event.type === "message_start" || event.type === "message_end") && event.message.role === "assistant"
				? event.message
				: undefined;
		// A user-facing description replaced the engine message, so the capture's frozen message must follow it.
		const described = message && "message" in source && source.message !== message ? message : undefined;
		this.emit(carryAssistantCapture(source, event, described));
	}

	dispose(): void {
		this.listeners.clear();
		this.releaseChannel?.();
		this.releaseChannel = undefined;
	}

	private emit(record: AgentSessionStructuredRecord): void {
		for (const listener of [...this.listeners]) listener(record);
	}
}
