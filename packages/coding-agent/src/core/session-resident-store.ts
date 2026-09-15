import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Buffer } from "buffer";

const RESIDENT_STRING_MIN_BYTES = 32 * 1024;
const DEFAULT_RESIDENT_STRING_BUDGET_BYTES = 64 * 1024 * 1024;
const RESIDENT_STRING_PREFIX = "\u0000senpi-resident-string:v1:";
const OMIT_JSON_VALUE = Symbol("omit-json-value");

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
	private strings = new Map<string, string>();
	private bytes = 0;
	private nextId = 0;
	private evictedCount = 0;
	private evictedBytes = 0;
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
		this.bytes = 0;
		this.nextId = 0;
		this.evictedCount = 0;
		this.evictedBytes = 0;
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
				this.bytes -= Buffer.byteLength(text, "utf8");
			}
		}
	}

	stats(): ResidentStoreStats {
		return {
			blobCount: this.strings.size,
			blobBytes: this.bytes,
			evictedCount: this.evictedCount,
			evictedBytes: this.evictedBytes,
		};
	}

	externalize<T>(value: T): T {
		return transformJson(value, (text) => this.externalizeString(text));
	}

	materialize<T>(value: T, onMissing?: (id: string) => string | undefined): T {
		return transformJson(value, (text) => this.materializeString(text, onMissing));
	}

	private externalizeString(text: string): string {
		if (text.length < RESIDENT_STRING_MIN_BYTES || text.startsWith(RESIDENT_STRING_PREFIX)) {
			return text;
		}

		const id = `${this.nextId++}`;
		this.strings.set(id, text);
		this.bytes += Buffer.byteLength(text, "utf8");
		this._enforceBudget();
		return `${RESIDENT_STRING_PREFIX}${id}`;
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
		while (this.bytes > this.maxBytes && this.strings.size > 0) {
			const [oldestId, oldest] = this.strings.entries().next().value as [string, string];
			if (!this._writeBlob(oldestId, oldest)) {
				return;
			}
			this.strings.delete(oldestId);
			this.bytes -= Buffer.byteLength(oldest, "utf8");
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
			writeFileSync(temp, text, "utf8");
			renameSync(temp, final);
		} catch {
			try {
				rmSync(temp, { force: true });
			} catch {}
			return false;
		}
		this.evictedCount++;
		this.evictedBytes += Buffer.byteLength(text, "utf8");
		return true;
	}

	private _readBlob(id: string): string | undefined {
		const dir = this.blobsDir?.();
		if (!dir) {
			return undefined;
		}
		try {
			return readFileSync(join(dir, `${id}.blob`), "utf8");
		} catch {
			return undefined;
		}
	}
}

function transformJson<T>(value: T, transformString: (text: string) => string): T {
	const transformed = transformJsonValue(value, transformString, "", new WeakSet());
	if (transformed === OMIT_JSON_VALUE) {
		const serialized = JSON.stringify(value);
		if (serialized === undefined) {
			throw new SyntaxError("JSON-compatible value expected");
		}
		return JSON.parse(serialized) as T;
	}
	return transformed as T;
}

function transformJsonValue(
	value: unknown,
	transformString: (text: string) => string,
	key: string,
	seen: WeakSet<object>,
): unknown | typeof OMIT_JSON_VALUE {
	if (typeof value === "string") {
		return transformString(value);
	}
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : null;
	}
	if (value === null || typeof value === "boolean") {
		return value;
	}
	if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
		return OMIT_JSON_VALUE;
	}

	if (seen.has(value)) {
		throw new TypeError("Converting circular structure to JSON");
	}
	seen.add(value);

	const jsonValue = hasJsonSerializer(value) ? value.toJSON(key) : value;
	if (jsonValue !== value) {
		const transformed = transformJsonValue(jsonValue, transformString, key, seen);
		seen.delete(value);
		return transformed;
	}

	if (Array.isArray(value)) {
		const transformed = Array.from({ length: value.length }, (_item, index) => {
			const item = value[index];
			const transformedItem = transformJsonValue(item, transformString, String(index), seen);
			return transformedItem === OMIT_JSON_VALUE ? null : transformedItem;
		});
		seen.delete(value);
		return transformed;
	}

	const transformed: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		const transformedItem = transformJsonValue(item, transformString, String(key), seen);
		if (transformedItem !== OMIT_JSON_VALUE) {
			Object.defineProperty(transformed, key, {
				configurable: true,
				enumerable: true,
				value: transformedItem,
				writable: true,
			});
		}
	}
	seen.delete(value);
	return transformed;
}

function hasJsonSerializer(value: object): value is { toJSON: (key: string) => unknown } {
	return "toJSON" in value && typeof value.toJSON === "function";
}
