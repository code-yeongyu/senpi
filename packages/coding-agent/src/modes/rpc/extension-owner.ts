import { randomUUID } from "node:crypto";
import type { ExtensionRpcRequestContext } from "../../core/extensions/rpc-context.ts";

/** Private host/worker metadata, never accepted from public command JSON. */
export interface ExtensionOwnerWire {
	readonly ownerId: string;
	readonly bindingGeneration: string;
	readonly retirement: SharedArrayBuffer;
}

/** The identity a targeted output frame carries back; the shared word stays with the host's own gate. */
export type ExtensionOwnerIdentity = Pick<ExtensionOwnerWire, "ownerId" | "bindingGeneration">;

/** Commands whose handlers may run extension effects receive a captured owner; control commands never do. */
export function carriesExtensionOwner(command: object): boolean {
	const type = "type" in command ? String(command.type) : "";
	return type === "extension_request" || type.startsWith("eval_cells.");
}

/** One attachment's shared effect gate plus isolate-local cancellation notification. */
export class ExtensionOwner {
	private readonly state: Int32Array;
	private readonly cancellation = new AbortController();
	readonly context: ExtensionRpcRequestContext;
	readonly wire: ExtensionOwnerWire;

	constructor(wire: ExtensionOwnerWire) {
		this.wire = wire;
		this.state = new Int32Array(wire.retirement);
		this.context = Object.freeze({
			ownerId: wire.ownerId,
			disconnectSignal: this.cancellation.signal,
			admit: <T>(dispatch: () => T): T => {
				// The atomic observation is the admission point, not abort-message delivery.
				if (Atomics.load(this.state, 0) !== 0) throw new DOMException("RPC owner retired", "AbortError");
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

	/** The gate already issued for a generation, without minting one. */
	peek(bindingGeneration: string): ExtensionOwner | undefined {
		return this.closed ? undefined : this.bindings.get(bindingGeneration);
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
