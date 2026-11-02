/** Internal to senpi packages; not a public API; may change without notice. */
import { type AssistantProgress, subscribeAssistantCapture } from "@earendil-works/pi-ai";
import type { AgentEvent, AgentLoopConfig } from "./types.ts";

export const internalProgressSink = Symbol("internalProgressSink");
type ProgressSink = (progress: AssistantProgress) => Promise<void> | undefined;
export type InternalLoopConfig = AgentLoopConfig & { [internalProgressSink]?: ProgressSink };
type InternalEvent = { event: AgentEvent } | { progress: AssistantProgress };
/** @internal For senpi's session layer only. */
export type OrderedAgentRecord = InternalEvent & { readonly sequence: number };
type Listener = (record: OrderedAgentRecord) => Promise<void> | void;
/** @internal Construction-time capability for senpi's session layer only. */
export interface InternalAgentChannel {
	subscribe(listener: Listener): () => void;
}
const channels = new WeakMap<InternalAgentChannel, { sequence: number; listeners: Set<Listener> }>();

/**
 * @internal For senpi's session layer only. Pass at Agent construction; an existing Agent cannot be attached.
 * Capture is held from the first listener until the last release, never by an idle channel.
 */
export function createInternalAgentChannel(): InternalAgentChannel {
	const state = { sequence: 0, listeners: new Set<Listener>() };
	let releaseCapture: (() => void) | undefined;
	const channel: InternalAgentChannel = Object.freeze({
		subscribe(listener: Listener): () => void {
			state.listeners.add(listener);
			releaseCapture ??= subscribeAssistantCapture();
			return () => {
				state.listeners.delete(listener);
				if (state.listeners.size === 0) {
					releaseCapture?.();
					releaseCapture = undefined;
				}
			};
		},
	});
	channels.set(channel, state);
	return channel;
}

/** A run started without an internal listener gets no sink, and its loop reads the public stream exactly as before. */
export function internalLoopSink(channel: InternalAgentChannel | undefined): { [internalProgressSink]?: ProgressSink } {
	if (!channel || !channels.get(channel)?.listeners.size) return {};
	return { [internalProgressSink]: (progress) => dispatchInternalAgent(channel, { progress }) };
}

/** Returns nothing, so it costs the public pipeline no microtask, while the owner has no internal listener. */
export function dispatchInternalAgent(
	channel: InternalAgentChannel | undefined,
	event: InternalEvent,
): Promise<void> | undefined {
	const state = channel && channels.get(channel);
	if (!state?.listeners.size) return undefined;
	const record = Object.freeze({ ...event, sequence: ++state.sequence });
	return (async () => {
		for (const listener of state.listeners) await listener(record);
	})();
}
