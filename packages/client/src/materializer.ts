import type { MaterializerEnvelope } from "./materializer-wire.ts";

/** A session incarnation's shared materializer, independent of its admission routes. */
export interface MaterializerIdentity {
	readonly sessionId: string;
	readonly sessionEpoch: string;
	readonly generation: number;
}

export interface MaterializerUnit<T = unknown> extends MaterializerIdentity {
	readonly kind: "unit";
	readonly sequence: number;
	readonly controls: readonly unknown[];
	readonly record: T;
}

export type MaterializerOutcome = "applied" | "duplicate";
export interface MaterializerSnapshot {
	readonly frontier: number;
	readonly effects: readonly unknown[];
}
export type MaterializerRefusalCode = "in_flight" | "aborted" | "stale_generation" | "invalid_unit" | "stray_control";

export class MaterializerRefusal extends Error {
	readonly code: MaterializerRefusalCode;
	constructor(code: MaterializerRefusalCode) {
		super(`materializer refused: ${code}`);
		this.name = "MaterializerRefusal";
		this.code = code;
	}
}

/** All effects remain private until commit atomically persists them AND the sequence frontier.
 * Abort or any apply throw discards everything. Commit must recheck generation and monotonicity.
 */
export interface MaterializerTransaction<T> {
	apply(unit: MaterializerUnit<T>): Promise<void>;
	commit(sequence: number): Promise<MaterializerOutcome>;
	abort(): Promise<void>;
}

/** RULING-95: the adapter owns single flight and durability, including across consumer instances.
 * A new generation aborts the old transaction and starts at frontier zero; equal resets are idempotent.
 * The ingress owner retires socket/session epochs before calling this transport-neutral consumer.
 */
export interface MaterializerAdapter<T> {
	reset(identity: MaterializerIdentity): Promise<void>;
	frontier(identity: MaterializerIdentity): Promise<number>;
	begin(identity: MaterializerIdentity): Promise<MaterializerTransaction<T>>;
}

/** Driven separately from RpcClient's synchronous listener; no unbounded queue or implicit retry. */
export class MaterializerConsumer<T = unknown> {
	private readonly adapter: MaterializerAdapter<T>;
	constructor(adapter: MaterializerAdapter<T>) {
		this.adapter = adapter;
	}

	reset(identity: MaterializerIdentity): Promise<void> {
		return this.adapter.reset(identity);
	}

	async accept(
		unit: MaterializerUnit<T> | (MaterializerIdentity & { readonly kind: "control"; readonly sequence: number }),
	): Promise<MaterializerOutcome> {
		// A stray control is a protocol error, including at a sequence already committed.
		if (unit.kind === "control") throw new MaterializerRefusal("stray_control");
		if (!Number.isSafeInteger(unit.sequence) || unit.sequence < 1 || !Array.isArray(unit.controls))
			throw new MaterializerRefusal("invalid_unit");
		return this.deliver(unit, async () => unit);
	}

	/** Acquire the transaction before loading: duplicates neither begin nor decode/copy the shared payload.
	 * The loader reads/stages the immutable S13 lease; release follows durable content ownership, not this read.
	 */
	acceptEnvelope(envelope: MaterializerEnvelope, load: () => Promise<T>): Promise<MaterializerOutcome> {
		return this.deliver(envelope, async () => ({ ...envelope, kind: "unit", record: await load() }));
	}

	private async deliver(
		unit: MaterializerIdentity & { readonly sequence: number },
		load: () => Promise<MaterializerUnit<T>>,
	): Promise<MaterializerOutcome> {
		await this.adapter.reset(unit);
		if (unit.sequence <= (await this.adapter.frontier(unit))) return "duplicate";
		const transaction = await this.adapter.begin(unit);
		try {
			await transaction.apply(await load());
			return await transaction.commit(unit.sequence);
		} catch (cause) {
			await transaction.abort();
			throw cause;
		}
	}
}
