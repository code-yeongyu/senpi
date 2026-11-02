import { endpointKey, type LocalEndpoint } from "./local-endpoint.ts";
import type { CarrierConnection, CarrierSide } from "./transport.ts";

/** One dialed link between two carrier sides; it can drop and re-attach. */
export interface CarrierLink {
	connect(): void;
	drop(): void;
	readonly connected: boolean;
}

export interface InProcessNetworkOptions {
	/** Runs one message hand-off later; default `queueMicrotask`. Tests pass manual timers. */
	readonly schedule?: (deliver: () => void) => void;
}

/** In-process carriers addressed by local endpoints, so fused and local runs need no socket. */
export interface InProcessNetwork {
	listen(endpoint: LocalEndpoint, side: CarrierSide): () => void;
	dial(endpoint: LocalEndpoint, side: CarrierSide): CarrierLink;
}

function createLink(a: CarrierSide, b: CarrierSide, schedule: (deliver: () => void) => void): CarrierLink {
	let generation = 0;
	let up = false;
	const drop = (): void => {
		if (!up) return;
		up = false;
		generation += 1;
		a.detached();
		b.detached();
	};
	const half = (to: CarrierSide, at: number): CarrierConnection => ({
		send: (message) => {
			schedule(() => {
				if (up && generation === at) to.message(message);
			});
			return true;
		},
		close: () => {
			if (generation === at) drop();
		},
	});
	return {
		connect() {
			if (up) return;
			up = true;
			generation += 1;
			a.attached(half(b, generation));
			b.attached(half(a, generation));
		},
		drop,
		get connected() {
			return up;
		},
	};
}

export function createInProcessNetwork(options: InProcessNetworkOptions = {}): InProcessNetwork {
	const schedule = options.schedule ?? queueMicrotask;
	const listeners = new Map<string, { readonly side: CarrierSide; dialed: boolean }>();
	return {
		listen(endpoint, side) {
			const key = endpointKey(endpoint);
			if (listeners.has(key)) throw new Error(`in-process carrier: ${endpoint.address} already has a listener`);
			listeners.set(key, { side, dialed: false });
			return () => void listeners.delete(key);
		},
		dial(endpoint, side) {
			const listener = listeners.get(endpointKey(endpoint));
			if (listener === undefined) throw new Error(`in-process carrier: no listener at ${endpoint.address}`);
			if (listener.dialed) throw new Error(`in-process carrier: ${endpoint.address} is already dialed`);
			listener.dialed = true;
			return createLink(side, listener.side, schedule);
		},
	};
}
