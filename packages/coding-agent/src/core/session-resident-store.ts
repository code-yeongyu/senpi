import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { transformJson } from "./session-resident-json.ts";
import { ResidentSizeAccounting, type ResidentStoreSize } from "./session-resident-store-size.ts";

const RESIDENT_STRING_MIN_BYTES = 32 * 1024;
const DEFAULT_RESIDENT_STRING_BUDGET_BYTES = 64 * 1024 * 1024;
export const RESIDENT_STRING_PREFIX = "\u0000senpi-resident-string:v1:";

export interface ResidentStoreStats {
	blobCount: number;
	blobBytes: number;
	evictedCount?: number;
	evictedBytes?: number;
}

export interface ResidentStringStoreOptions {
	// Eviction only runs when a recoverable backing directory is configured;
	// without one, dropping a string would leave consumers holding unreadable
	// sentinel tokens, so strings stay resident beyond the budget instead.
	maxBytes?: number;
	blobsDir?: () => string | undefined;
}

export class ResidentStringStore {
	private readonly tokenFree = new WeakSet<object>();
	// Keyed by content hash: the id IS the reverse index, so the same text always
	// resolves to the same token and the same blob file, across store instances
	// sharing a backing directory and across eviction/spill cycles.
	private strings = new Map<string, string>();
	private readonly accounting = new ResidentSizeAccounting();
	private readonly maxBytes: number;
	private blobsDir?: () => string | undefined;

	constructor(options: ResidentStringStoreOptions = {}) {
		this.maxBytes = options.maxBytes ?? DEFAULT_RESIDENT_STRING_BUDGET_BYTES;
		this.blobsDir = options.blobsDir;
	}

	configure(options: { blobsDir?: () => string | undefined }): void {
		this.blobsDir = options.blobsDir;
	}

	clear(): void {
		this.strings.clear();
		this.accounting.reset();
		const dir = this.blobsDir?.();
		if (dir) {
			try {
				rmSync(dir, { force: true, recursive: true });
			} catch {}
		}
	}

	/**
	 * Unlike clear(), the blob backing itself survives: consumers of entries that
	 * were spilled keep hydrating from it instead of falling back to a full JSONL
	 * reload. Used where the store is emptied in place (post-compaction mirror
	 * trim) rather than across a session switch.
	 */
	spillResident(): void {
		const dir = this.blobsDir?.();
		if (!dir) {
			return;
		}
		for (const [id, text] of this.strings) {
			if (this._writeBlob(id, text)) {
				this.strings.delete(id);
				this.accounting.removed(text);
			}
		}
	}

	stats(): ResidentStoreStats {
		return { blobCount: this.strings.size, ...this.accounting.stats() };
	}

	/** Strings held in memory and their summed UTF-8 length, kept as strings come and go (no serialization). */
	size(): ResidentStoreSize {
		return { entries: this.strings.size, approxBytes: this.accounting.residentBytes };
	}

	externalize<T>(value: T): T {
		let tokenized = false;
		const externalized = transformJson(value, (text) => {
			const stored = this.externalizeString(text);
			if (stored.startsWith(RESIDENT_STRING_PREFIX)) tokenized = true;
			return stored;
		});
		if (!tokenized && typeof externalized === "object" && externalized !== null) this.tokenFree.add(externalized);
		return externalized;
	}

	/**
	 * An externalized value without resident tokens is already the store's own JSON-normalized copy,
	 * so it is returned as is; copying every entry on every read made each context build copy the
	 * whole session. Readers must not mutate what they get, as `getEntries()` already documents.
	 */
	materialize<T>(value: T, onMissing?: (id: string) => string | undefined): T {
		if (typeof value === "object" && value !== null && this.tokenFree.has(value)) return value;
		return transformJson(value, (text) => this.materializeString(text, onMissing));
	}

	/**
	 * Whether `externalize` returned this value without any resident token: it is then the store's
	 * JSON-normalized copy and `materialize` returns it as is.
	 */
	isTokenFree(value: object): boolean {
		return this.tokenFree.has(value);
	}

	/** Records `value` as token-free, so `materialize` returns it as is (senpi#2537). */
	adoptTokenFree(value: object): void {
		this.tokenFree.add(value);
	}

	resolvedBlobsDir(): string | undefined {
		return this.blobsDir?.();
	}

	/**
	 * Replace large strings reachable from `value` with resident tokens, mutating
	 * the object graph in place so consumer-held references stay valid.
	 */
	externalizeInPlace(value: unknown): void {
		this._mutateStringsInPlace(value, new Set(), (text) => this.externalizeString(text));
	}

	/** Hydrate resident tokens reachable from `value` in place (inverse of externalizeInPlace). */
	materializeInPlace(value: unknown): void {
		this._mutateStringsInPlace(value, new Set(), (text) => this.materializeString(text));
	}

	private _mutateStringsInPlace(value: unknown, seen: Set<object>, mutate: (text: string) => string): void {
		if (typeof value !== "object" || value === null || seen.has(value)) {
			return;
		}
		seen.add(value);
		const record = value as Record<string, unknown>;
		for (const key of Object.keys(record)) {
			const current = record[key];
			if (typeof current === "string") {
				const next = mutate(current);
				// Skip the write when nothing changes: a read-only walk must stay safe on
				// frozen or shared message objects (senpi#2525).
				if (next !== current) record[key] = next;
			} else if (typeof current === "object" && current !== null) {
				this._mutateStringsInPlace(current, seen, mutate);
			}
		}
	}

	private externalizeString(text: string): string {
		if (text.length < RESIDENT_STRING_MIN_BYTES || text.startsWith(RESIDENT_STRING_PREFIX)) {
			return text;
		}

		const id = createHash("sha256").update(text, "utf8").digest("hex");
		const token = `${RESIDENT_STRING_PREFIX}${id}`;
		if (this.strings.has(id)) {
			// Map insertion order is the eviction order; a re-externalize refreshes recency.
			this.strings.delete(id);
			this.strings.set(id, text);
			return token;
		}

		this.strings.set(id, text);
		this.accounting.added(text);
		this._enforceBudget();
		return token;
	}

	private materializeString(text: string, onMissing?: (id: string) => string | undefined): string {
		if (!text.startsWith(RESIDENT_STRING_PREFIX)) {
			return text;
		}

		const id = text.slice(RESIDENT_STRING_PREFIX.length);
		const resident = this.strings.get(id);
		if (resident !== undefined) {
			// Map insertion order is the eviction order; a read refreshes recency.
			this.strings.delete(id);
			this.strings.set(id, resident);
			return resident;
		}
		// Hydration is transient on purpose: the string must not re-enter the
		// resident cache, or one bulk read would refill the entire budget. The
		// caller's JSONL recovery remains the authority for a missing blob.
		const hydrated = this._readBlob(id);
		if (hydrated !== undefined) {
			return hydrated;
		}
		return onMissing?.(id) ?? text;
	}

	private _enforceBudget(): void {
		while (this.accounting.residentBytes > this.maxBytes && this.strings.size > 0) {
			const [oldestId, oldest] = this.strings.entries().next().value as [string, string];
			if (!this._writeBlob(oldestId, oldest)) {
				return;
			}
			this.strings.delete(oldestId);
			this.accounting.removed(oldest);
		}
	}

	private _writeBlob(id: string, text: string): boolean {
		const dir = this.blobsDir?.();
		if (!dir) {
			return false;
		}
		const final = join(dir, `${id}.blob`);
		const temp = `${final}.tmp`;
		try {
			mkdirSync(dir, { recursive: true });
			// The id is the content hash, so an existing blob already holds these exact
			// bytes: skip the rewrite but still report the eviction, because the string
			// is leaving memory either way.
			if (!existsSync(final)) {
				// Blobs are JSON envelopes so a truncated or mangled file fails the read
				// below and falls back to JSONL recovery instead of hydrating garbage.
				writeFileSync(temp, JSON.stringify({ v: 1, text }), "utf8");
				renameSync(temp, final);
			}
		} catch {
			try {
				rmSync(temp, { force: true });
			} catch {}
			return false;
		}
		this.accounting.evicted(text);
		return true;
	}

	private _readBlob(id: string): string | undefined {
		const dir = this.blobsDir?.();
		if (!dir) {
			return undefined;
		}
		const file = join(dir, `${id}.blob`);
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8")) as { text?: unknown };
			if (typeof parsed.text === "string") {
				return parsed.text;
			}
		} catch {}
		// The blob is missing or unusable. Drop whatever is there so the next eviction
		// of this content writes a readable blob instead of skipping over a broken one.
		try {
			rmSync(file, { force: true });
		} catch {}
		return undefined;
	}
}
