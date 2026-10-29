import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { parseBoundedId } from "./compact-recovery-ids.ts";
import { CompactAdmissionError } from "./compact-admission-error.ts";
import { AdmissionProducerLifetime, runAdmissionProducer } from "./compact-admission-producer.ts";
import {
	ADMISSION_LIMITS,
	type AdmissionRow as Row,
	readAdmissionRow,
	writeAdmissionRow,
} from "./compact-admission-row.ts";
export { CompactAdmissionError } from "./compact-admission-error.ts";
export { ADMISSION_LIMITS } from "./compact-admission-row.ts";
type Answer = Readonly<Record<string, unknown>>;
type Produced = {
	readonly answer: Answer;
	readonly release: () => Promise<void>;
	readonly activate?: () => void;
	readonly refusal?: () => Answer | undefined;
};
type Pending = ReturnType<typeof Promise.withResolvers<Answer>>;
type Epoch = {
	readonly producer: AdmissionProducerLifetime;
	readonly peer: string;
	readonly directory: Promise<string>;
	readonly hot: Map<string, Pending>;
	tail: Promise<void>;
	entries: number;
	ended: boolean;
	waiting: number;
};

/** Host-owned epoch index. Hash-file lookup is bounded by one <=131,584-byte row; hot results are never history. */
export class CompactAdmissions {
	private readonly epochs = new Map<string, Epoch>();
	private readonly limits: Readonly<{ entries: number; bytes: number }>;
	private abandoned = 0;

	status() {
		return { abandoned: this.abandoned };
	}

	private end(epoch: Epoch): void {
		epoch.ended = true;
		epoch.producer.end(() => {
			const count = epoch.hot.size;
			this.abandoned += count;
			if (count > 0) process.stderr.write(`senpi rpc abandoned ${count} admission producer(s) at open deadline\n`);
		});
	}

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
				producer: new AdmissionProducerLifetime(),
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

	async run(
		identity: {
			readonly socketEpoch: string;
			readonly peer: string;
			readonly admissionId: string;
			readonly fingerprint: string;
		},
		produce: (signal: AbortSignal) => Promise<Produced>,
	): Promise<Answer> {
		const key = this.key(identity.admissionId);
		const epoch = this.epoch(identity.socketEpoch, identity.peer);
		const registered = await this.serial(epoch, async () => {
			if (epoch.ended) throw new CompactAdmissionError("admission_retired");
			const row = await readAdmissionRow(epoch, key);
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
			await writeAdmissionRow(epoch, key, { state: "pending", fingerprint: identity.fingerprint });
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
			produced = await runAdmissionProducer(
				epoch.producer.signal,
				() => produce(epoch.producer.signal),
				(value) => value.release(),
			);
			let value = produced.answer;
			const cancelled = await this.serial(epoch, async () => {
				const row = await readAdmissionRow(epoch, key);
				const retired = epoch.ended || row?.state === "cancelled";
				const persist = async () => {
					const answer = JSON.stringify(value);
					if (Buffer.byteLength(answer) > 65_536) throw new CompactAdmissionError("storage_unavailable");
					await writeAdmissionRow(epoch, key, {
						state: retired ? "cancelled" : "complete",
						fingerprint: identity.fingerprint,
						answer,
					});
				};
				value = produced?.refusal?.() ?? value;
				await persist();
				// Overflow during the durable write is a terminal, replayable refusal, not a fresh attempt.
				const refused = produced?.refusal?.();
				if (refused && JSON.stringify(refused) !== JSON.stringify(value)) {
					value = refused;
					await persist();
				}
				if (retired || epoch.ended || refused) return true;
				// RULING-93: durable terminal row FIRST, synchronous activation SECOND. A crash
				// between them ends this connection, which retires its subscription and pending buffer.
				try {
					produced?.activate?.();
				} catch {
					process.stderr.write("senpi rpc admission activation failed; releasing subscription\n");
					throw new CompactAdmissionError("storage_unavailable");
				}
				return false;
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
					writeAdmissionRow(epoch, key, { state: "failed", fingerprint: identity.fingerprint }),
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
			const row = await readAdmissionRow(epoch, key);
			if (!row) return "unknown";
			switch (row.state) {
				case "complete":
				case "failed":
					return "already_complete";
				case "cancelled":
					return "cancelled";
				case "pending":
					await writeAdmissionRow(epoch, key, { ...row, state: "cancelled" });
					return "cancelled";
			}
		});
	}

	/** Resolve an accepted or cancelled late result through the same epoch index, with no second history. */
	async result(
		socketEpoch: string,
		admissionId: string,
	): Promise<{ state: Row["state"]; answer: Answer } | undefined> {
		const key = this.key(admissionId);
		const epoch = this.epochs.get(socketEpoch);
		if (!epoch) return undefined;
		return this.serial(epoch, async () => {
			const row = await readAdmissionRow(epoch, key);
			if (row?.answer === undefined) return undefined;
			return { state: row.state, answer: z.record(z.string(), z.unknown()).parse(JSON.parse(row.answer)) };
		});
	}

	async forgetPeer(socketEpoch: string): Promise<void> {
		const epoch = this.epochs.get(socketEpoch);
		if (!epoch) return;
		this.end(epoch);
		await Promise.allSettled([...epoch.hot.values()].map((pending) => pending.promise));
		await epoch.tail;
		epoch.producer.close();
		await rm(await epoch.directory, { recursive: true, force: true });
		this.epochs.delete(socketEpoch);
	}

	endConnection(peer: string): void {
		for (const epoch of this.epochs.values()) if (epoch.peer === peer) this.end(epoch);
	}

	async forgetConnection(peer: string): Promise<void> {
		for (const [id, epoch] of this.epochs) if (epoch.peer === peer) await this.forgetPeer(id);
	}

	async dispose(): Promise<void> {
		for (const epoch of this.epochs.values()) this.end(epoch);
		for (const id of this.epochs.keys()) await this.forgetPeer(id);
	}
}
