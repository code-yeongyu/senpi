import type { FrozenBytes } from "./compact-recovery-bytes.ts";
import type { ContentRef } from "./compact-recovery-ids.ts";

/**
 * The verified byte sources of one host's frozen roots (RULING-69 (2)): a component's open-time verification runs once
 * per frozen root, so a re-open on that root serves pages without re-reading a leaf. A root is pinned by exactly one
 * checkpoint token, so entries are keyed by the token and dropped with its lease. An entry holds leaf positions only,
 * never bytes: at most one number per stored leaf of the root's catalog.
 */
export class VerifiedComponents {
	private readonly roots = new Map<string, Map<ContentRef, FrozenBytes>>();

	get size(): number {
		let size = 0;
		for (const components of this.roots.values()) size += components.size;
		return size;
	}

	get(tokenId: string, ref: ContentRef): FrozenBytes | undefined {
		return this.roots.get(tokenId)?.get(ref);
	}

	set(tokenId: string, ref: ContentRef, bytes: FrozenBytes): void {
		let components = this.roots.get(tokenId);
		if (!components) {
			components = new Map();
			this.roots.set(tokenId, components);
		}
		components.set(ref, bytes);
	}

	drop(tokenId: string): void {
		this.roots.delete(tokenId);
	}
}
