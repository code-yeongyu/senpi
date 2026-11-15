// H3 fixture: a hand's durable wake outbox and a brain's inbox, joined by the wake link on the reference transport over
// an in-process carrier. Each `connect` is one hand process's link; the brain's inbox outlives every link.
import {
	createAdmissionLine,
	createHandWakeLink,
	createInProcessNetwork,
	createMemoryStoreMedium,
	createReliableTransport,
	createWakeInbox,
	type HandWakeLink,
	localEndpoint,
	openMemoryStore,
	serveHandWakes,
	type BrainWakeLink,
	type TransportSide,
	type WakeDrop,
	type WakeEvent,
	type WakeInbox,
	type WakeOutbox,
	type WakeRefusal,
} from "@earendil-works/pi-agent-core";
import { handWakesOver } from "../../src/modes/hand/hand-wakes.ts";
import type { HandWakes } from "../../src/modes/rpc/remote-executor-scope.ts";

export const WAIT_MS = 15_000;
export const HAND = "hand-under-test";

export function within<T>(promise: Promise<T>, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} did not happen within ${WAIT_MS}ms`)), WAIT_MS);
	});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Values in arrival order; `next()` takes the oldest unread one, or waits for it. */
export function arrivals<T>(): {
	readonly push: (value: T) => void;
	readonly next: (what: string) => Promise<T>;
	readonly all: T[];
} {
	const all: T[] = [];
	const waiting: Array<(value: T) => void> = [];
	let read = 0;
	return {
		all,
		push(value) {
			all.push(value);
			const waiter = waiting.shift();
			if (waiter !== undefined) {
				read += 1;
				waiter(value);
			}
		},
		next(what) {
			if (read < all.length) return Promise.resolve(all[read++] as T);
			return within(new Promise<T>((resolve) => waiting.push(resolve)), what);
		},
	};
}

function side(): TransportSide {
	return createReliableTransport({
		clock: {
			now: () => Date.now(),
			setTimer: (callback, ms) => {
				const timer = setTimeout(callback, ms);
				return () => clearTimeout(timer);
			},
		},
		onHandlerError: (error) => {
			throw error;
		},
	});
}

/** `outbox`, telling the test when it recorded an offer and when it applied an ack, instead of the test polling it. */
export function observed(
	outbox: WakeOutbox,
	on: { readonly offered?: () => void; readonly acked?: () => void; readonly refused?: () => void },
): WakeOutbox {
	return {
		...outbox,
		offer: async (wake) => {
			const event = await outbox.offer(wake);
			on.offered?.();
			return event;
		},
		receipt: async (receipt) => {
			await outbox.receipt(receipt);
			if (receipt.kind === "ack") on.acked?.();
			else on.refused?.();
		},
	};
}

export interface Brain {
	readonly inbox: WakeInbox;
	readonly committed: ReturnType<typeof arrivals<WakeEvent>>;
	readonly dropped: ReturnType<typeof arrivals<WakeDrop>>;
	readonly faults: unknown[];
}

export async function brainInbox(owned: (scope: string) => boolean = () => true): Promise<Brain> {
	const medium = createMemoryStoreMedium();
	await openMemoryStore(medium).claim(0, 1);
	const inbox = createWakeInbox({
		issuer: "brain",
		store: openMemoryStore(medium),
		epoch: 1,
		admission: createAdmissionLine(),
		clock: () => Date.now(),
		owner: (scope) => (owned(scope) ? HAND : undefined),
	});
	return { inbox, committed: arrivals<WakeEvent>(), dropped: arrivals<WakeDrop>(), faults: [] };
}

export interface WakeConnection {
	readonly hand: HandWakeLink;
	readonly brain: BrainWakeLink;
	readonly wakes: HandWakes;
	readonly faults: unknown[];
	close(): void;
}

/**
 * One hand process's link to the brain. `loseReceipts` drops every receipt the brain sends on this link (the reply that
 * would have acked the wake never reaches the hand), as a link that dies right after the brain committed.
 */
export function connect(
	brain: Brain,
	outbox: WakeOutbox,
	options: { readonly loseReceipts?: boolean; readonly check?: (wake: WakeEvent) => WakeRefusal | undefined } = {},
): WakeConnection {
	const network = createInProcessNetwork();
	const endpoint = localEndpoint("linux", `hand-wake-${crypto.randomUUID()}`, "/tmp");
	const brainSide = side();
	const handSide = side();
	const stop = network.listen(endpoint, handSide);
	const carrier = network.dial(endpoint, brainSide);
	carrier.connect();
	const faults: unknown[] = [];
	const brainTransport: TransportSide =
		options.loseReceipts === true
			? { ...brainSide, send: () => Promise.resolve(), onFrame: (handler) => brainSide.onFrame(handler) }
			: brainSide;
	const brainLink = serveHandWakes({
		transport: brainTransport,
		inbox: brain.inbox,
		hand: HAND,
		...(options.check === undefined ? {} : { check: options.check }),
		onCommitted: brain.committed.push,
		onDropped: brain.dropped.push,
		onFault: (error) => brain.faults.push(error),
	});
	const hand = createHandWakeLink({ transport: handSide, outbox, onFault: (error) => faults.push(error) });
	return {
		hand,
		brain: brainLink,
		wakes: handWakesOver(hand),
		faults,
		close() {
			hand.close();
			brainLink.close();
			carrier.drop();
			stop();
			brainSide.close();
			handSide.close();
		},
	};
}
