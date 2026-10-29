import { randomUUID } from "node:crypto";
import type { ExtensionRpcRequestContext } from "../../core/extensions/rpc-context.ts";

/** Private host/worker metadata, never accepted from public command JSON. */
export interface ExtensionOwnerWire {
	readonly ownerId: string;
	readonly bindingGeneration: string;
	readonly retirement: SharedArrayBuffer;
}

/** One attachment's shared effect gate plus isolate-local cancellation notification. */
export class ExtensionOwner {
	private readonly state: Int32Array;
	private readonly cancellation = new AbortController();
	readonly context: ExtensionRpcRequestContext;

	constructor(readonly wire: ExtensionOwnerWire) {
		this.state = new Int32Array(wire.retirement);
		this.context = Object.freeze({
			ownerId: wire.ownerId,
			disconnectSignal: this.cancellation.signal,
			admit: <T>(dispatch: () => T): T => {
				// The atomic observation is the admission point, not abort-message delivery.
				if (Atomics.load(this.state, 0) !== 0)
					throw new DOMException("RPC owner retired", "AbortError");
				return dispatch();
			},
		});
	}

	get retired(): boolean {
		return Atomics.load(this.state, 0) !== 0;
	}

	retire(): void {
		Atomics.store(this.state, 0, 1);
		this.cancellation.abort();
	}
}

/** Minted once per actual transport registration, independently of its reusable routing ID. */
export class ExtensionTransportOwner {
	readonly ownerId = randomUUID();
	private readonly bindings = new Map<string, ExtensionOwner>();
	private closed = false;

	get retired(): boolean {
		return this.closed;
	}

	capture(bindingGeneration: string): ExtensionOwner {
		if (this.closed) throw new DOMException("RPC transport retired", "AbortError");
		const existing = this.bindings.get(bindingGeneration);
		if (existing) return existing;
		const owner = new ExtensionOwner({
			ownerId: this.ownerId,
			bindingGeneration,
			retirement: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
		});
		this.bindings.set(bindingGeneration, owner);
		return owner;
	}

	retireBinding(bindingGeneration: string): void {
		this.bindings.get(bindingGeneration)?.retire();
	}

	retire(): void {
		this.closed = true;
		for (const owner of this.bindings.values()) owner.retire();
		this.bindings.clear();
	}
}
