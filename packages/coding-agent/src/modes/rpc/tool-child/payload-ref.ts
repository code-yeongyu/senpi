import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { refFilePath, teardownRefGeneration } from "./payload-ref-paths.ts";
import { type PayloadRef, type RefControl, type RefNackReason, TOOL_CHILD_LIMITS } from "./protocol.ts";
import { isRefId } from "./protocol-guard.ts";

export type PayloadRefErrorCode = "ref_budget_exceeded" | "ref_rejected" | "ref_not_owned";

export class PayloadRefError extends Error {
	readonly code: PayloadRefErrorCode;
	readonly reason: RefNackReason | undefined;
	constructor(code: PayloadRefErrorCode, message: string, reason?: RefNackReason) {
		super(`${code}: ${message}`);
		this.name = "PayloadRefError";
		this.code = code;
		this.reason = reason;
	}
}

export interface PayloadRefWriterOptions {
	root: string;
	generation: number;
	budget?: number | undefined;
	now?: (() => number) | undefined;
}

interface PendingRef {
	bytes: number;
	createdAtMs: number;
}

/**
 * Writer side of an acknowledged payload reference. The writer owns a ref only until the receiver answers:
 * `ref_ack` transfers ownership (the writer forgets the file and never deletes it), `ref_nack` makes the writer
 * delete it. Settling the sending operation changes nothing; only generation teardown removes an unanswered ref.
 */
export class PayloadRefWriter {
	readonly generation: number;
	readonly budget: number;
	readonly #root: string;
	readonly #now: () => number;
	readonly #pending = new Map<string, PendingRef>();
	#ownedBytes = 0;

	constructor(options: PayloadRefWriterOptions) {
		this.generation = options.generation;
		this.budget = options.budget ?? TOOL_CHILD_LIMITS.refsBudget;
		this.#root = options.root;
		this.#now = options.now ?? Date.now;
	}

	get ownedBytes(): number {
		return this.#ownedBytes;
	}

	async create(payload: Uint8Array): Promise<PayloadRef> {
		const size = payload.byteLength;
		if (this.#ownedBytes + size > this.budget) {
			throw new PayloadRefError(
				"ref_budget_exceeded",
				`${size} bytes on top of ${this.#ownedBytes} owned exceeds ${this.budget}`,
			);
		}
		this.#ownedBytes += size;
		const ref: PayloadRef = {
			refId: randomBytes(12).toString("hex"),
			generation: this.generation,
			bytes: size,
			sha256: createHash("sha256").update(payload).digest("hex"),
		};
		const path = refFilePath(this.#root, ref);
		try {
			await mkdir(dirname(path), { recursive: true, mode: 0o700 });
			await writeFile(path, payload, { flag: "wx", mode: 0o600 });
		} catch (error) {
			this.#ownedBytes -= size;
			await rm(path, { force: true });
			throw error;
		}
		this.#pending.set(ref.refId, { bytes: size, createdAtMs: this.#now() });
		return ref;
	}

	/** A `ref_ack` or `ref_nack` from the receiver; an answer for a ref this writer does not hold is ignored. */
	async handle(control: RefControl): Promise<void> {
		const pending = this.#pending.get(control.refId);
		if (pending === undefined) return;
		this.#pending.delete(control.refId);
		this.#ownedBytes -= pending.bytes;
		if (control.type === "ref_nack") {
			await rm(refFilePath(this.#root, { refId: control.refId, generation: this.generation }), { force: true });
		}
	}

	pendingIds(): string[] {
		return [...this.#pending.keys()];
	}

	/** Refs still unanswered after `refAckMs`; reported for liveness handling, never deleted here. */
	overdue(): string[] {
		const deadline = this.#now() - TOOL_CHILD_LIMITS.refAckMs;
		return [...this.#pending].filter(([, ref]) => ref.createdAtMs <= deadline).map(([refId]) => refId);
	}

	async teardown(): Promise<void> {
		this.#pending.clear();
		this.#ownedBytes = 0;
		await teardownRefGeneration(this.#root, this.generation);
	}
}

export interface PayloadRefReaderOptions {
	root: string;
	generation: number;
	budget?: number | undefined;
	send: (control: RefControl) => void;
}

export type RefAcceptance = { ok: true } | { ok: false; reason: RefNackReason };

const isMissingFile = (error: unknown): boolean =>
	error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");

async function hashFile(path: string, signal: AbortSignal | undefined): Promise<string | "cancelled"> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) {
		if (signal?.aborted) return "cancelled";
		hash.update(chunk);
	}
	return hash.digest("hex");
}

/**
 * Receiver side. `accept` verifies size and sha256 and answers `ref_ack` (taking ownership) or `ref_nack`.
 * The owner deletes the file when it consumes it; a dead owner's files go with its generation's teardown.
 */
export class PayloadRefReader {
	readonly #root: string;
	readonly #generation: number;
	readonly #budget: number;
	readonly #send: (control: RefControl) => void;
	readonly #owned = new Map<string, PayloadRef>();
	#ownedBytes = 0;

	constructor(options: PayloadRefReaderOptions) {
		this.#root = options.root;
		this.#generation = options.generation;
		this.#budget = options.budget ?? TOOL_CHILD_LIMITS.refsBudget;
		this.#send = options.send;
	}

	async accept(ref: PayloadRef, signal?: AbortSignal): Promise<RefAcceptance> {
		const reason = await this.#verify(ref, signal);
		if (reason !== undefined) {
			this.refuse(ref, reason);
			return { ok: false, reason };
		}
		this.#owned.set(ref.refId, ref);
		this.#ownedBytes += ref.bytes;
		this.#send({ type: "ref_ack", refId: ref.refId });
		return { ok: true };
	}

	/** Answers `ref_nack` for a ref this side will not take, e.g. one whose job was cancelled before it was opened. */
	refuse(ref: PayloadRef, reason: RefNackReason): void {
		if (this.#owned.has(ref.refId)) return;
		this.#send({ type: "ref_nack", refId: ref.refId, reason });
	}

	async consume(refId: string): Promise<Uint8Array> {
		const ref = this.#owned.get(refId);
		if (ref === undefined) throw new PayloadRefError("ref_not_owned", `ref ${refId} is not owned by this side`);
		const path = refFilePath(this.#root, ref);
		const bytes = await readFile(path);
		await rm(path, { force: true });
		this.#owned.delete(refId);
		this.#ownedBytes -= ref.bytes;
		return bytes;
	}

	ownedIds(): string[] {
		return [...this.#owned.keys()];
	}

	async #verify(ref: PayloadRef, signal: AbortSignal | undefined): Promise<RefNackReason | undefined> {
		if (signal?.aborted) return "cancelled";
		if (ref.generation !== this.#generation || !isRefId(ref.refId) || this.#owned.has(ref.refId)) return "foreign";
		if (this.#ownedBytes + ref.bytes > this.#budget) return "budget";
		const path = refFilePath(this.#root, ref);
		try {
			if ((await stat(path)).size !== ref.bytes) return "corrupt";
			const digest = await hashFile(path, signal);
			if (digest === "cancelled") return "cancelled";
			return digest === ref.sha256 ? undefined : "corrupt";
		} catch (error) {
			if (isMissingFile(error)) return "missing";
			throw error;
		}
	}
}
