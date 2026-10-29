import { AsyncLocalStorage } from "node:async_hooks";
import type { ExtensionOwner, ExtensionOwnerIdentity, ExtensionTransportOwner } from "./extension-owner.ts";

interface CapturedConnection {
	readonly id: string;
	readonly owner: ExtensionTransportOwner | undefined;
	readonly binding?: ExtensionOwner;
}

/** Capture registrations before awaits; a routing string is never an incarnation. */
export class SessionConnectionContext {
	private readonly storage = new AsyncLocalStorage<CapturedConnection>();

	private readonly ownerOf: (id: string) => ExtensionTransportOwner | undefined;

	constructor(ownerOf: (id: string) => ExtensionTransportOwner | undefined) {
		this.ownerOf = ownerOf;
	}

	run<T>(id: string, task: () => T): T {
		return this.storage.run({ id, owner: this.ownerOf(id) }, task);
	}

	/**
	 * Route a worker's targeted output to the exact incarnation and binding generation that captured it.
	 * A routing string now registered to another transport, or a retired gate, leaves the frame stale.
	 */
	runCaptured<T>(id: string, identity: ExtensionOwnerIdentity, task: () => T): T {
		const owner = this.ownerOf(id);
		const binding = owner?.ownerId === identity.ownerId ? owner.peek(identity.bindingGeneration) : undefined;
		return this.storage.run({ id, owner: binding === undefined ? undefined : owner, binding }, task);
	}

	/** A session isolate has no transports of its own: it runs a command with the gate its host captured. */
	runIssued<T>(id: string, binding: ExtensionOwner, task: () => T): T {
		return this.storage.run({ id, owner: undefined, binding }, task);
	}

	getStore(): string | undefined {
		return this.storage.getStore()?.id;
	}

	transportOf(id: string): ExtensionTransportOwner | undefined {
		return this.ownerOf(id);
	}

	get transport(): ExtensionTransportOwner | undefined {
		return this.storage.getStore()?.owner;
	}

	get owner(): ExtensionOwner | undefined {
		return this.storage.getStore()?.binding;
	}

	withBinding<T>(generation: string, task: () => T): T {
		const captured = this.storage.getStore();
		if (!captured?.owner) return task();
		return this.storage.run({ ...captured, binding: captured.owner.capture(generation) }, task);
	}

	isCurrent(): boolean {
		return this.currentGuard()();
	}

	/** A check of the captured destination that stays valid after this async context ends (queued output). */
	currentGuard(): () => boolean {
		const captured = this.storage.getStore();
		if (!captured) return () => true;
		return () =>
			captured.owner !== undefined &&
			this.ownerOf(captured.id) === captured.owner &&
			!captured.owner.retired &&
			captured.binding?.retired !== true;
	}
}
