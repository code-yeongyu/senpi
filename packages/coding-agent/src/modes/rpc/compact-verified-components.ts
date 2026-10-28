import type { FrozenBytes } from "./compact-recovery-bytes.ts";
import type { ContentRef } from "./compact-recovery-ids.ts";
import type { FrozenAcceptedRoot } from "./session-acceptance-lane.ts";

/**
 * A second checkpoint token tried to pin a frozen root another live token still pins: the one-token-per-root invariant
 * the verified-component cache rests on is broken. An internal defect, never a refusal a peer can cause or recover from.
 */
export class FrozenRootPinnedError extends Error {
	readonly tokenId: string;
	readonly holder: string;

	constructor(tokenId: string, holder: string) {
		super(`frozen root already pinned by token ${holder}; token ${tokenId} cannot pin it`);
		this.name = "FrozenRootPinnedError";
		this.tokenId = tokenId;
		this.holder = holder;
	}
}

interface PinnedRoot {
	readonly token: string;
	readonly components: Map<ContentRef, FrozenBytes>;
}

/**
 * The verified byte sources of one host's frozen roots (RULING-69 (2)): a component's open-time verification runs once
 * per frozen root, so a re-open on that root serves pages without re-reading a leaf. Entries are keyed by the root and
 * dropped with the lease of the one token that pins it.
 *
 * Invariant: a frozen root is pinned by exactly one live token. `RecoveryCheckpoints.freeze` is the only place a token
 * is minted, and it pins the root its own `lane.freeze()` call just built; every freeze builds a new root object with
 * its own references (`SessionAcceptanceLane.freeze`, `CompactLaneCurrent.freeze`, `CompactSessionState.freeze`), so
 * two peers, a re-attach or a shed's resync each get a root of their own, and `RecoveryCheckpoints.retain` hands a root
 * to a non-token consumer under the same token's lease. A
 * second peer on the same session therefore never shares an entry; it verifies its own root once. `pin` enforces the
 * invariant with `FrozenRootPinnedError` instead of serving or overwriting another token's entries.
 * An entry holds leaf positions only, never bytes: at most one number per stored leaf of the root's catalog.
 */
export class VerifiedComponents {
	private readonly roots = new Map<FrozenAcceptedRoot, PinnedRoot>();
	private readonly pinned = new Map<string, FrozenAcceptedRoot>();

	get size(): number {
		let size = 0;
		for (const { components } of this.roots.values()) size += components.size;
		return size;
	}

	/** Registers `tokenId` as the root's one holder; idempotent for that token, a typed internal error for another. */
	pin(tokenId: string, root: FrozenAcceptedRoot): void {
		const held = this.roots.get(root);
		if (held) {
			if (held.token !== tokenId) throw new FrozenRootPinnedError(tokenId, held.token);
			return;
		}
		this.roots.set(root, { token: tokenId, components: new Map() });
		this.pinned.set(tokenId, root);
	}

	get(root: FrozenAcceptedRoot, ref: ContentRef): FrozenBytes | undefined {
		return this.roots.get(root)?.components.get(ref);
	}

	/** Cached only while `tokenId` still pins `root`; once its lease dropped the entry, a late open caches nothing. */
	set(tokenId: string, root: FrozenAcceptedRoot, ref: ContentRef, bytes: FrozenBytes): void {
		const held = this.roots.get(root);
		if (!held) return;
		if (held.token !== tokenId) throw new FrozenRootPinnedError(tokenId, held.token);
		held.components.set(ref, bytes);
	}

	drop(tokenId: string): void {
		const root = this.pinned.get(tokenId);
		if (!root) return;
		this.pinned.delete(tokenId);
		this.roots.delete(root);
	}
}
