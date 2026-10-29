import { randomUUID } from "node:crypto";
import { type ExtensionOwner, ExtensionTransportOwner } from "./extension-owner.ts";

/** One session handler's captures, retired synchronously before replacement or disposal awaits. */
export class ExtensionOwnerLifetime {
	private readonly classic: ExtensionTransportOwner | undefined;
	private generation = randomUUID();
	private readonly captures = new Set<ExtensionOwner>();

	private readonly source: (() => ExtensionOwner | undefined) | undefined;
	private readonly onRetireBinding: (() => void) | undefined;

	constructor(isClassic: boolean, source?: () => ExtensionOwner | undefined, onRetireBinding?: () => void) {
		this.source = source;
		this.onRetireBinding = onRetireBinding;
		this.classic = isClassic && source === undefined ? new ExtensionTransportOwner() : undefined;
	}

	capture(): ExtensionOwner | undefined {
		const owner = this.source === undefined ? this.classic?.capture(this.generation) : this.source();
		if (owner) this.captures.add(owner);
		return owner;
	}

	retireBinding(): void {
		const hadCaptures = this.captures.size > 0;
		for (const owner of this.captures) owner.retire();
		this.captures.clear();
		this.generation = randomUUID();
		if (hadCaptures) this.onRetireBinding?.();
	}

	dispose(): void {
		this.retireBinding();
		this.classic?.retire();
	}
}
