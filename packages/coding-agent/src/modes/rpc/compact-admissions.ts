import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { parseBoundedId } from "./compact-recovery-ids.ts";

/** Per socket epoch: 128 IDs, 16 MiB reserved disk bytes, 16 live producers. No retired ID is evicted. */
export const ADMISSION_LIMITS = { entries: 128, bytes: 16 * 1024 * 1024, hot: 16, row: 131_584 } as const;
const rowSchema = z.object({
	fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
	state: z.enum(["pending", "complete", "cancelled", "failed"]),
	answer: z.string().max(65_536).optional(),
});
type Row = z.infer<typeof rowSchema>;
type Answer = Readonly<Record<string, unknown>>;
type Produced = { readonly answer: Answer; readonly release: () => Promise<void> };
type Pending = ReturnType<typeof Promise.withResolvers<Answer>>;
type Epoch = {
	readonly peer: string;
	readonly directory: Promise<string>;
	readonly hot: Map<string, Pending>;
	tail: Promise<void>;
	entries: number;
	ended: boolean;
	waiting: number;
};

export class CompactAdmissionError extends Error {
	readonly reason:
		| "malformed_request"
		| "admission_conflict"
		| "admission_retired"
		| "admission_limit"
		| "admission_busy"
		| "storage_unavailable";

	constructor(reason: CompactAdmissionError["reason"]) {
		super(reason);
		this.reason = reason;
		this.name = "CompactAdmissionError";
	}
}

/** Host-owned epoch index. Hash-file lookup is bounded by one <=131,584-byte row; hot results are never history. */
export class CompactAdmissions {
	private readonly epochs = new Map<string, Epoch>();
	private readonly limits: Readonly<{ entries: number; bytes: number }>;

	constructor(limits: Readonly<{ entries: number; bytes: number }> = ADMISSION_LIMITS) {
		this.limits = limits;
	}

	private key(id: string): string {
		if (!parseBoundedId(id).ok) throw new CompactAdmissionError("malformed_request");
		return createHash("sha256").update(id).digest("hex");
	}

	private epoch(id: string, peer: string): Epoch {
		let epoch = this.epochs.get(id);
		if (!epoch) {
			epoch = {
				peer,
				directory: mkdtemp(join(tmpdir(), "senpi-admissions-")),
				hot: new Map(),
				tail: Promise.resolve(),
				entries: 0,
				ended: false,
				waiting: 0,
			};
			this.epochs.set(id, epoch);
		}
		return epoch;
	}

	private async serial<T>(epoch: Epoch, action: () => Promise<T>): Promise<T> {
		if (epoch.waiting >= ADMISSION_LIMITS.hot) throw new CompactAdmissionError("admission_busy");
		epoch.waiting++;
		const previous = epoch.tail;
		const done = Promise.withResolvers<void>();
		epoch.tail = done.promise;
		await previous;
		try {
			return await action();
		} finally {
			epoch.waiting--;
			done.resolve();
		}
	}

	private async read(epoch: Epoch, key: string): Promise<Row | undefined> {
		try {
			const text = await readFile(join(await epoch.directory, key), "utf8");
			if (Buffer.byteLength(text) > ADMISSION_LIMITS.row) throw new CompactAdmissionError("storage_unavailable");
			return rowSchema.parse(JSON.parse(text));
		} catch (cause) {
			if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
			if (cause instanceof CompactAdmissionError) throw cause;
			throw new CompactAdmissionError("storage_unavailable");
		}
	}

	private async write(epoch: Epoch, key: string, row: Row): Promise<void> {
		const text = JSON.stringify(row);
		if (Buffer.byteLength(text) > ADMISSION_LIMITS.row) throw new CompactAdmissionError("storage_unavailable");
		try {
			await writeFile(join(await epoch.directory, key), text, { mode: 0o600 });
		} catch (cause) {
			if (!(cause instanceof Error)) throw cause;
			throw new CompactAdmissionError("storage_unavailable");
		}
	}

	async run(
		identity: {
			readonly socketEpoch: string;
			readonly peer: string;
			readonly admissionId: string;
			readonly fingerprint: string;
		},
		produce: () => Promise<Produced>,
	): Promise<Answer> {
		const key = this.key(identity.admissionId);
		const epoch = this.epoch(identity.socketEpoch, identity.peer);
		const registered = await this.serial(epoch, async () => {
			if (epoch.ended) throw new CompactAdmissionError("admission_retired");
			const row = await this.read(epoch, key);
			if (row) {
				if (row.fingerprint !== identity.fingerprint) throw new CompactAdmissionError("admission_conflict");
				switch (row.state) {
					case "complete":
						if (row.answer === undefined) throw new CompactAdmissionError("storage_unavailable");
						return {
							kind: "complete",
							answer: z.record(z.string(), z.unknown()).parse(JSON.parse(row.answer)),
						} as const;
					case "cancelled":
					case "failed":
						throw new CompactAdmissionError("admission_retired");
					case "pending": {
						const pending = epoch.hot.get(key);
						if (!pending) throw new CompactAdmissionError("storage_unavailable");
						return { kind: "join", pending } as const;
					}
				}
			}
			if (epoch.entries >= this.limits.entries || (epoch.entries + 1) * ADMISSION_LIMITS.row > this.limits.bytes)
				throw new CompactAdmissionError("admission_limit");
			if (epoch.hot.size >= ADMISSION_LIMITS.hot) throw new CompactAdmissionError("admission_busy");
			await this.write(epoch, key, { state: "pending", fingerprint: identity.fingerprint });
			epoch.entries++;
			const pending = Promise.withResolvers<Answer>();
			void pending.promise.catch(() => {});
			epoch.hot.set(key, pending);
			return { kind: "fresh", pending } as const;
		});
		switch (registered.kind) {
			case "complete":
				return registered.answer;
			case "join":
				return registered.pending.promise;
			case "fresh":
				break;
		}
		let produced: Produced | undefined;
		try {
			produced = await produce();
			const value = produced.answer;
			const answer = JSON.stringify(produced.answer);
			if (Buffer.byteLength(answer) > 65_536) throw new CompactAdmissionError("storage_unavailable");
			const cancelled = await this.serial(epoch, async () => {
				const row = await this.read(epoch, key);
				const retired = epoch.ended || row?.state === "cancelled";
				await this.write(epoch, key, {
					state: retired ? "cancelled" : "complete",
					fingerprint: identity.fingerprint,
					answer,
				});
				return retired;
			});
			if (cancelled) {
				const release = produced.release;
				produced = undefined;
				await release();
			}
			registered.pending.resolve(value);
			return value;
		} catch (cause) {
			if (produced) await produced.release();
			try {
				await this.serial(epoch, () =>
					this.write(epoch, key, { state: "failed", fingerprint: identity.fingerprint }),
				);
			} finally {
				registered.pending.reject(cause);
			}
			throw cause;
		} finally {
			epoch.hot.delete(key);
		}
	}

	async cancel(socketEpoch: string, admissionId: string): Promise<"cancelled" | "already_complete" | "unknown"> {
		const key = this.key(admissionId);
		const epoch = this.epochs.get(socketEpoch);
		if (!epoch) return "unknown";
		return this.serial(epoch, async () => {
			const row = await this.read(epoch, key);
			if (!row) return "unknown";
			switch (row.state) {
				case "complete":
				case "failed":
					return "already_complete";
				case "cancelled":
					return "cancelled";
				case "pending":
					await this.write(epoch, key, { ...row, state: "cancelled" });
					return "cancelled";
			}
		});
	}

	async forgetPeer(socketEpoch: string): Promise<void> {
		const epoch = this.epochs.get(socketEpoch);
		if (!epoch) return;
		epoch.ended = true;
		await Promise.allSettled([...epoch.hot.values()].map((pending) => pending.promise));
		await epoch.tail;
		await rm(await epoch.directory, { recursive: true, force: true });
		this.epochs.delete(socketEpoch);
	}

	endConnection(peer: string): void {
		for (const epoch of this.epochs.values()) if (epoch.peer === peer) epoch.ended = true;
	}

	async forgetConnection(peer: string): Promise<void> {
		for (const [id, epoch] of this.epochs) if (epoch.peer === peer) await this.forgetPeer(id);
	}

	async dispose(): Promise<void> {
		for (const epoch of this.epochs.values()) epoch.ended = true;
		for (const id of this.epochs.keys()) await this.forgetPeer(id);
	}
}
