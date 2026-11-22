/**
 * The codemode extension's wire contract with its host process (senpi#2561, senpi#1960): the live
 * kernel registry and the main-thread heap figure. The host never imports the extension, and the
 * extension publishes one registry under a process-global key; this module is the single reader of
 * both, so the RPC host and the memory report cannot drift apart on what the registry holds.
 */
import { Type } from "typebox";
import { Value } from "typebox/value";

/** The codemode extension's kernel registry key (kernel-registry.ts publishes under it). */
export const KERNEL_REGISTRY_KEY = Symbol.for("senpi.codemode.kernel-registry");

/** One kernel's memory as the host reports it: every consumer renders this same shape. */
export interface HostKernelMemoryRow {
	readonly sessionId: string;
	readonly language: string;
	readonly liveBytes: number;
	readonly measure: string;
}

/**
 * The registry's full listing, kept by the report; the RPC row is a projection of it. The listing
 * names `lastLiveBytes` (the wire field) and never fabricates `liveBytes`; the row projection maps
 * it, reporting 0 between readings.
 */
export interface HostKernelListing {
	readonly id: string;
	readonly sessionId: string;
	readonly language: string;
	readonly measure: string;
	readonly lastLiveBytes?: number;
	/** A cell was running: `lastLiveBytes` is the last reading, not what the kernel holds now. */
	readonly stale: boolean;
	readonly pid?: number;
}

const kernelListingSchema = Type.Object({
	id: Type.String(),
	sessionId: Type.String(),
	language: Type.String(),
	measure: Type.String(),
	lastLiveBytes: Type.Optional(Type.Number()),
	busy: Type.Boolean(),
	pid: Type.Optional(Type.Number()),
});

/** The registry's full listing, validated once here; `busy` maps to `stale` at the boundary. */
export function readCodemodeKernelListings(): readonly HostKernelListing[] {
	const registry: unknown = Reflect.get(globalThis, KERNEL_REGISTRY_KEY);
	if (typeof registry !== "object" || registry === null) return [];
	const list: unknown = Reflect.get(registry, "list");
	if (typeof list !== "function") return [];
	const listed: unknown = Reflect.apply(list, registry, []);
	if (!Array.isArray(listed)) return [];
	return listed
		.filter((entry) => Value.Check(kernelListingSchema, entry))
		.map(({ busy, ...entry }) => ({ ...entry, stale: busy }));
}

/**
 * One row per live kernel for the RPC surface; a kernel between readings lists `liveBytes: 0`
 * rather than a guess, and a kernel that crashed is absent from the next listing.
 */
export function readCodemodeKernelRows(): readonly HostKernelMemoryRow[] {
	return readCodemodeKernelListings().map(({ sessionId, language, measure, lastLiveBytes }) => ({
		sessionId,
		language,
		liveBytes: lastLiveBytes ?? 0,
		measure,
	}));
}

/** Main-thread heap in bytes: `bun:jsc heapSize()` when the runtime offers it, else `heapUsed`. */
export function readMainThreadHeapBytes(): number {
	return jscHeapSizeOnBun() ?? process.memoryUsage().heapUsed;
}

/** `bun:jsc` answers synchronously on Bun and is absent on Node, where the figure is omitted. */
export function jscHeapSizeOnBun(): number | undefined {
	const jsc: unknown = process.getBuiltinModule("bun:jsc");
	if (typeof jsc !== "object" || jsc === null) return undefined;
	const heapSize: unknown = Reflect.get(jsc, "heapSize");
	if (typeof heapSize !== "function") return undefined;
	const bytes: unknown = Reflect.apply(heapSize, jsc, []);
	return typeof bytes === "number" ? bytes : undefined;
}
