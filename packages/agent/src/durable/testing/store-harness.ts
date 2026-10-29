import type {
	DurableStore,
	DurableStoreErrorCode,
	DurableStoreOptions,
	StoreSnapshot,
	StoreWritePoint,
} from "../store.ts";
import { DurableStoreError } from "../store.ts";

/** What a host provides to the STORE and KILL-STORE cases. */
export interface StoreConformanceAdapter {
	/** A new, empty durable medium (a Durable Object's storage, an SQLite file); its name opens it again. */
	createMedium(): Promise<string>;
	/** A store instance over `medium`. Instances opened on one medium share its durable state. */
	open(medium: string, options?: DurableStoreOptions): Promise<DurableStore>;
}

export interface StoreCaseAdapters {
	readonly store: StoreConformanceAdapter;
}

class CutSignal extends Error {
	constructor(point: StoreWritePoint) {
		super(`cut at ${JSON.stringify(point)}`);
		this.name = "CutSignal";
	}
}

const samePoint = (a: StoreWritePoint, b: StoreWritePoint): boolean =>
	a.op === b.op && a.at === b.at && (a.at !== "write" || (b.at === "write" && a.index === b.index));

export function cutOnceAt(target: StoreWritePoint): DurableStoreOptions {
	let armed = true;
	return {
		onWritePoint: (point) => {
			if (armed && samePoint(point, target)) {
				armed = false;
				throw new CutSignal(point);
			}
		},
	};
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "undefined";
}

export function expectEqual(actual: unknown, expected: unknown, what: string): void {
	const a = canonical(actual);
	const e = canonical(expected);
	if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`);
}

export async function expectStoreError(
	operation: Promise<unknown>,
	code: DurableStoreErrorCode,
	what: string,
): Promise<void> {
	try {
		await operation;
	} catch (error) {
		if (error instanceof DurableStoreError && error.code === code) return;
		throw new Error(`${what}: expected DurableStoreError ${code}, got ${String(error)}`);
	}
	throw new Error(`${what}: expected DurableStoreError ${code}, but it resolved`);
}

export async function expectCut(operation: Promise<unknown>, what: string): Promise<void> {
	try {
		await operation;
	} catch (error) {
		if (error instanceof CutSignal) return;
		throw new Error(`${what}: expected the cut to surface, got ${String(error)}`);
	}
	throw new Error(`${what}: expected the cut to surface, but it resolved`);
}

export async function reopenSnapshot(adapter: StoreConformanceAdapter, medium: string): Promise<StoreSnapshot> {
	return (await adapter.open(medium)).exportSnapshot();
}

export function adoptLog(): {
	readonly calls: string[];
	adopt: (result: { readonly seqs: readonly number[] }) => void;
} {
	const calls: string[] = [];
	return { calls, adopt: (result) => void calls.push(`adopt:${result.seqs.join(",")}`) };
}
