import { AsyncLocalStorage } from "node:async_hooks";
import type { ExtensionOwner, ExtensionTransportOwner } from "./extension-owner.ts";

interface CapturedConnection {
	readonly id: string;
	readonly owner: ExtensionTransportOwner | undefined;
	readonly binding?: ExtensionOwner;
}

/** Capture registrations before awaits; a routing string is never an incarnation. */
export class SessionConnectionContext {
	private readonly storage = new AsyncLocalStorage<CapturedConnection>();

	constructor(private readonly ownerOf: (id: string) => ExtensionTransportOwner | undefined) {}

	run<T>(id: string, task: () => T): T {
		return this.storage.run({ id, owner: this.ownerOf(id) }, task);
	}

	runCaptured<T>(id: string, ownerId: string, task: () => T): T | undefined {
		const owner = this.ownerOf(id);
		if (!owner || owner.ownerId !== ownerId || owner.retired) return undefined;
		return this.storage.run({ id, owner }, task);
	}

	getStore(): string | undefined {
		return this.storage.getStore()?.id;
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
		const captured = this.storage.getStore();
		if (!captured) return true;
		return captured.owner !== undefined &&
			this.ownerOf(captured.id) === captured.owner &&
			!captured.owner.retired &&
			captured.binding?.retired !== true;
	}
}
