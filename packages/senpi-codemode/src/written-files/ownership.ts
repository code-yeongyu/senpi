import type { FileSignature } from "./scan-boundaries.ts";

/** The settling cell a claimed file belongs to. */
export interface Owner {
	closed: boolean;
}

/** A file a settlement will hook; `started` once its hooks were dispatched, so closing the cell keeps it. */
export interface Claim {
	readonly owner: Owner;
	started: boolean;
	/** The file's baseline before this settlement advanced it to `advanced`; absent for a file new to the baseline. */
	readonly before: FileSignature | undefined;
	readonly advanced: FileSignature;
}

/**
 * Who a changed file belongs to while write hooks run on it, keyed by workspace path: the settlement that claimed it,
 * or the model `write` and `edit` calls writing it. A settlement leaves an owned file and its baseline alone.
 */
export class FileOwnership {
	readonly #claims = new Map<string, Claim>();
	/** How many model calls are writing and hooking each file. */
	readonly #calls = new Map<string, number>();

	owned(path: string): boolean {
		return this.#claims.has(path) || this.#calls.has(path);
	}

	claim(path: string, claim: Claim): void {
		this.#claims.set(path, claim);
	}

	claimOf(path: string, owner: Owner): Claim | undefined {
		const claim = this.#claims.get(path);
		return claim?.owner === owner ? claim : undefined;
	}

	claimsOf(owner: Owner): Array<[string, Claim]> {
		return [...this.#claims].filter(([, claim]) => claim.owner === owner);
	}

	endClaim(path: string): void {
		this.#claims.delete(path);
	}

	/** A model call holds the file until it calls the returned function, once. */
	holdForCall(path: string): () => void {
		this.#calls.set(path, (this.#calls.get(path) ?? 0) + 1);
		return () => {
			const left = (this.#calls.get(path) ?? 1) - 1;
			if (left > 0) this.#calls.set(path, left);
			else this.#calls.delete(path);
		};
	}
}
