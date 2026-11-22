import type { FileSignature } from "./scan-boundaries.ts";

/** The settling cell a claimed file belongs to. */
export interface Owner {
	closed: boolean;
}

/** A file a settlement will hook; `started` once its hooks were dispatched, so closing the cell keeps it. */
export interface Claim {
	readonly owner: Owner;
	started: boolean;
	/** A model call took the file since the claim: the claim cedes it if not yet started, and records nothing for it. */
	contested: boolean;
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
	/** Per settlement between its first look and its claims: the files model calls took meanwhile. */
	readonly #watches = new Set<Set<string>>();

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

	/** Records every file a model call takes from now until `stop`: a settlement's look at it may be stale. */
	watchHolds(): { readonly taken: ReadonlySet<string>; stop(): void } {
		const taken = new Set<string>();
		this.#watches.add(taken);
		return { taken, stop: () => this.#watches.delete(taken) };
	}

	/**
	 * A model call holds the file until it calls the returned function, once. It never waits: a settlement that looked
	 * at the file meanwhile, or claimed it, learns of the call here.
	 */
	holdForCall(path: string): () => void {
		this.#calls.set(path, (this.#calls.get(path) ?? 0) + 1);
		for (const taken of this.#watches) taken.add(path);
		const claim = this.#claims.get(path);
		if (claim !== undefined) claim.contested = true;
		return () => {
			const left = (this.#calls.get(path) ?? 1) - 1;
			if (left > 0) this.#calls.set(path, left);
			else this.#calls.delete(path);
		};
	}
}
