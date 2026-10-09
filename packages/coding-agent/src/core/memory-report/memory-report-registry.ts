import { envValue } from "../brand.ts";
import type { MemoryReporter } from "../extensions/types.ts";
import type { ResidentStoreSize } from "../session-resident-store-size.ts";

/** `SENPI_MEMORY_REPORT=1` installs the on-demand report; nothing is installed or kept without it. */
export const MEMORY_REPORT_ENV = "SENPI_MEMORY_REPORT";
/** `SENPI_MEMORY_REPORT_SNAPSHOT=1` adds a heap snapshot to each report (itself a large allocation). */
export const MEMORY_REPORT_SNAPSHOT_ENV = "SENPI_MEMORY_REPORT_SNAPSHOT";

export function memoryReportEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return envValue("MEMORY_REPORT", env) === "1";
}

export function memoryReportSnapshotEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return envValue("MEMORY_REPORT_SNAPSHOT", env) === "1";
}

/** Keys the report owns; an extension reporter cannot shadow them. */
export const RESERVED_MEMORY_REPORT_KEYS: ReadonlySet<string> = new Set([
	"sessionId",
	"takenAt",
	"pid",
	"main",
	"kernels",
	"residentStore",
	"tuiRenderCache",
	"heapSnapshot",
	"reporterErrors",
]);

export interface NamedMemoryReporter {
	readonly name: string;
	readonly reporter: MemoryReporter;
}

/** What a live session contributes to its report; read only when a report is requested. */
export interface MemoryReportSessionSource {
	sessionId(): string;
	sessionFile(): string | undefined;
	residentStore(): ResidentStoreSize;
	reporters(): readonly NamedMemoryReporter[];
}

export interface TuiRenderCacheTotals {
	readonly components: number;
	readonly cachedLines: number;
	readonly images: number;
	/** Cards that finished and keep a retained \`result\` (senpi#1960). */
	readonly finishedCards: number;
	/** Byte cost of every live card's cached rendered lines (2 per code unit + 8 per array slot). */
	readonly cachedLinesBytes: number;
	/** Serialized size of the retained \`result\` over every finished card, computed once at finalize. */
	readonly resultBytes: number;
}

interface MemoryReportState {
	readonly sessions: Map<object, MemoryReportSessionSource>;
	tuiRenderCache: (() => TuiRenderCacheTotals) | undefined;
}

// Process-wide, whichever bundle chunk evaluates this module: the RPC handler is loaded lazily and must
// see the sessions the eagerly loaded session runtime registered.
const STATE_KEY = Symbol.for("senpi.memory-report.state");

function state(): MemoryReportState {
	const existing: unknown = Reflect.get(globalThis, STATE_KEY);
	if (isState(existing)) return existing;
	const created: MemoryReportState = { sessions: new Map(), tuiRenderCache: undefined };
	Reflect.set(globalThis, STATE_KEY, created);
	return created;
}

function isState(value: unknown): value is MemoryReportState {
	return typeof value === "object" && value !== null && Reflect.get(value, "sessions") instanceof Map;
}

/** Lists `owner`'s session for reports while the flag is on; the returned function removes it. */
export function registerMemoryReportSession(owner: object, source: MemoryReportSessionSource): () => void {
	if (!memoryReportEnabled()) return () => {};
	const { sessions } = state();
	sessions.set(owner, source);
	return () => {
		if (sessions.get(owner) === source) sessions.delete(owner);
	};
}

export function memoryReportSessionFor(owner: object): MemoryReportSessionSource | undefined {
	return state().sessions.get(owner);
}

export function memoryReportSessions(): MemoryReportSessionSource[] {
	return [...state().sessions.values()];
}

/** Called by the terminal UI: only a process that renders tool cards reports their render cache. */
export function registerTuiRenderCacheSource(read: () => TuiRenderCacheTotals): void {
	state().tuiRenderCache = read;
}

export function tuiRenderCacheTotals(): TuiRenderCacheTotals | undefined {
	return state().tuiRenderCache?.();
}
