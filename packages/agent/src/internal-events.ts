import { type AssistantProgress, subscribeAssistantCapture } from "@earendil-works/pi-ai";
import type { AgentEvent, AgentLoopConfig } from "./types.ts";

export const internalProgressSink = Symbol("internalProgressSink");
type ProgressSink = (progress: AssistantProgress) => Promise<void> | undefined;
export type InternalLoopConfig = AgentLoopConfig & { [internalProgressSink]?: ProgressSink };
type InternalEvent = { event: AgentEvent } | { progress: AssistantProgress };
export type OrderedAgentRecord = InternalEvent & { readonly sequence: number };
type Listener = (record: OrderedAgentRecord) => Promise<void> | void;
const channels = new WeakMap<object, { sequence: number; listeners: Set<Listener> }>();

/**
 * S02a owner seam: deliberately not exported by the package barrel or subscribed by a host.
 * A listener holds a capture subscription, so provider streams that first push after it build capture records.
 */
export function subscribeInternalAgent(owner: object, listener: Listener): () => void {
	let channel = channels.get(owner);
	if (!channel) {
		channel = { sequence: 0, listeners: new Set() };
		channels.set(owner, channel);
	}
	channel.listeners.add(listener);
	const release = subscribeAssistantCapture();
	return () => {
		channel.listeners.delete(listener);
		release();
	};
}

/** A run started without an internal listener gets no sink, and its loop reads the public stream exactly as before. */
export function internalLoopSink(owner: object): { [internalProgressSink]?: ProgressSink } {
	if (!channels.get(owner)?.listeners.size) return {};
	return { [internalProgressSink]: (progress) => dispatchInternalAgent(owner, { progress }) };
}

/** Returns nothing, so it costs the public pipeline no microtask, while the owner has no internal listener. */
export function dispatchInternalAgent(owner: object, event: InternalEvent): Promise<void> | undefined {
	const channel = channels.get(owner);
	if (!channel?.listeners.size) return undefined;
	const record = Object.freeze({ ...event, sequence: ++channel.sequence });
	return (async () => {
		for (const listener of channel.listeners) await listener(record);
	})();
}
