export class CompactReadError extends Error {
	readonly reason: "released" | "retired" | "range" | "size_limit" | "count_limit" | "ownership";

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

	constructor(dispose: () => void) {
		this.dispose = dispose;
	}

	assert(): void {
		if (this.released) throw new CompactReadError("released");
	}

	async run<T>(read: () => Promise<T>): Promise<T> {
		this.assert();
		this.operations++;
		try {
			const result = await read();
			this.assert();
			return result;
		} finally {
			if (--this.operations === 0 && this.released) this.dispose();
		}
	}

	release(): void {
		if (this.released) return;
		this.released = true;
		if (this.operations === 0) this.dispose();
	}
}
