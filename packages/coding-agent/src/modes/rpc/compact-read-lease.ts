export class CompactReadError extends Error {
	readonly reason: "released" | "retired" | "range" | "size_limit" | "count_limit" | "ownership" | "unavailable";

	constructor(reason: CompactReadError["reason"]) {
		super(`compact read refused (${reason})`);
		this.name = "CompactReadError";
		this.reason = reason;
	}
}

/** Invalidates immediately, but holds the owner's references until its last operation unwinds. */
export class CompactReadLease {
	private released = false;
	private operations = 0;
	private readonly dispose: () => void;
	private readonly valid: () => void;

	constructor(dispose: () => void, valid: () => void = () => undefined) {
		this.dispose = dispose;
		this.valid = valid;
	}

	assert(): void {
		if (this.released) throw new CompactReadError("released");
		this.valid();
	}

	async run<T>(read: () => Promise<T>): Promise<T> {
		this.assert();
		return this.hold(async () => {
			const result = await read();
			this.assert();
			return result;
		});
	}

	/**
	 * Runs `read` as an operation in flight without the validity check: a reader of the frozen snapshot itself (a
	 * legacy view) keeps the references until it unwinds even if the lease is released meanwhile.
	 */
	async hold<T>(read: () => Promise<T>): Promise<T> {
		if (this.released) throw new CompactReadError("released");
		this.operations++;
		try {
			return await read();
		} finally {
			if (--this.operations === 0 && this.released) this.dispose();
		}
	}

	/**
	 * One operation in flight from now until the returned `end` (idempotent): a consumer that was handed the snapshot
	 * keeps the references across a release meanwhile.
	 */
	retain(): () => void {
		if (this.released) throw new CompactReadError("released");
		this.operations++;
		let ended = false;
		return () => {
			if (ended) return;
			ended = true;
			if (--this.operations === 0 && this.released) this.dispose();
		};
	}

	/** True only for the call that released it: a later release, or one after another owner's, is a no-op. */
	release(): boolean {
		if (this.released) return false;
		this.released = true;
		if (this.operations === 0) this.dispose();
		return true;
	}
}
