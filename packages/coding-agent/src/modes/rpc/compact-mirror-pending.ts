/** Selected mirror admission only: 128 records / 1 MiB before activation; no uncharged lines[]. */
export const MIRROR_PENDING_LIMITS = { entries: 128, bytes: 1024 * 1024 } as const;

export class MirrorPending {
	private records: { readonly deliver: () => void; readonly drop?: () => void }[] = [];
	private bytes = 0;
	private active = false;
	reason: "admission_limit" | "attempt_cancelled" | "storage_unavailable" | undefined;

	status() {
		return { entries: this.records.length, bytes: this.bytes };
	}

	enqueue(line: string, deliver: () => void, drop?: () => void): void {
		if (this.reason) {
			drop?.();
			return;
		}
		if (this.active) {
			deliver();
			return;
		}
		const bytes = Buffer.byteLength(line);
		if (this.records.length >= MIRROR_PENDING_LIMITS.entries || this.bytes + bytes > MIRROR_PENDING_LIMITS.bytes) {
			this.reason = "admission_limit";
			this.clear();
			drop?.();
			return;
		}
		this.bytes += bytes;
		this.records.push({ deliver, drop });
	}

	/** Synchronous ownership transfer into the already installed actor barrier, never a second producer. */
	activate(): void {
		if (this.reason || this.active) return;
		this.active = true;
		const records = this.records;
		this.records = [];
		this.bytes = 0;
		for (const record of records) record.deliver();
	}

	retire(reason: "attempt_cancelled" | "storage_unavailable" = "attempt_cancelled"): void {
		this.reason ??= reason;
		this.clear();
	}

	private clear(): void {
		for (const record of this.records) record.drop?.();
		this.records = [];
		this.bytes = 0;
	}
}
