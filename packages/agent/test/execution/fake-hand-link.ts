import {
	decodeRemoteMessage,
	encodeRemoteMessage,
	type RemoteHandMessage,
} from "../../src/execution/remote-protocol.ts";
import type { FrameHandler, Transport } from "../../src/transport/transport.ts";

export function fakeHandLink() {
	const sent: RemoteHandMessage[] = [];
	const waiters: Array<{ readonly count: number; readonly resolve: () => void }> = [];
	let handler: FrameHandler | undefined;
	const transport: Transport = {
		send: async (_lane, payload) => {
			sent.push(decodeRemoteMessage(payload));
			for (const waiter of waiters) if (sent.length >= waiter.count) waiter.resolve();
		},
		onFrame: (next) => {
			handler = next;
		},
		inFlight: () => 0,
		close: () => {},
	};
	/** Delivers `message` on `lane` (an invoke defaults to its scope's lane) and settles when the hand's handler does. */
	const deliver = async (message: RemoteHandMessage, lane?: string): Promise<void> => {
		if (handler === undefined) throw new Error("no frame handler");
		const on = lane ?? (message.kind === "invoke" ? message.scope.id : "hand.control");
		await handler({ lane: on, payload: encodeRemoteMessage(message) });
	};
	const sentCount = (count: number): Promise<void> => {
		const { promise, resolve } = Promise.withResolvers<void>();
		waiters.push({ count, resolve });
		if (sent.length >= count) resolve();
		return promise;
	};
	return { transport, sent, deliver, sentCount };
}
