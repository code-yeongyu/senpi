import { type ProcessFootprint, readOwnFootprint } from "../process-footprint.ts";
import type { ResidentStoreSize } from "../session-resident-store-size.ts";
import { type HostKernelListing, jscHeapSizeOnBun, readCodemodeKernelListings } from "./kernel-registry-read.ts";
import {
	type MemoryReportSessionSource,
	type NamedMemoryReporter,
	RESERVED_MEMORY_REPORT_KEYS,
	type TuiRenderCacheTotals,
	tuiRenderCacheTotals,
} from "./memory-report-registry.ts";

export interface MainThreadMemory {
	readonly jscHeapSize?: number;
	readonly heapUsed: number;
	readonly external: number;
	readonly footprint: ProcessFootprint;
}

/** The report keeps the registry's full listing; the shared reader validates the wire shape once. */
type KernelMemoryEntry = HostKernelListing;

export interface MemoryReportCore {
	readonly sessionId: string;
	readonly takenAt: string;
	readonly pid: number;
	readonly main: MainThreadMemory;
	readonly kernels: readonly KernelMemoryEntry[];
	readonly residentStore: ResidentStoreSize;
	readonly tuiRenderCache?: TuiRenderCacheTotals;
	/** Frame-level figure from the TUI (senpi#1960): byte cost of the lines the last frame holds. */
	readonly tui?: { readonly previousLinesBytes: number };
	readonly heapSnapshot?: string;
	readonly reporterErrors?: Readonly<Record<string, string>>;
}

/** The core sections plus one section per extension reporter, keyed by the reporter's name. */
export type MemoryReport = MemoryReportCore & Readonly<Record<string, unknown>>;

export function buildMemoryReport(source: MemoryReportSessionSource, heapSnapshot?: string): MemoryReport {
	const { sections, errors } = reporterSections(source.reporters());
	const tuiRenderCache = tuiRenderCacheTotals();
	const frameLineBytes = readFrameLineBytes();
	const core: MemoryReportCore = {
		sessionId: source.sessionId(),
		takenAt: new Date().toISOString(),
		pid: process.pid,
		main: mainThreadMemory(),
		kernels: readCodemodeKernelListings(),
		residentStore: source.residentStore(),
		...(tuiRenderCache === undefined ? {} : { tuiRenderCache }),
		...(frameLineBytes === undefined ? {} : { tui: { previousLinesBytes: frameLineBytes } }),
		...(heapSnapshot === undefined ? {} : { heapSnapshot }),
		...(Object.keys(errors).length === 0 ? {} : { reporterErrors: errors }),
	};
	return { ...sections, ...core };
}

function mainThreadMemory(): MainThreadMemory {
	const usage = process.memoryUsage();
	const jscHeapSize = jscHeapSizeOnBun();
	return {
		...(jscHeapSize === undefined ? {} : { jscHeapSize }),
		heapUsed: usage.heapUsed,
		external: usage.external,
		footprint: readOwnFootprint(),
	};
}

// The TUI publishes its frame-line byte total under this process-global key (tui.ts); read structurally
// so the report never imports the renderer into a host that runs headless.
const FRAME_LINE_BYTES_KEY = Symbol.for("senpi.tui.frame-line-bytes");

/** The TUI's frame-line byte total, or \`undefined\` in a process that has not rendered a frame yet. */
function readFrameLineBytes(): number | undefined {
	const state: unknown = Reflect.get(globalThis, FRAME_LINE_BYTES_KEY);
	if (typeof state !== "object" || state === null) return undefined;
	const bytes: unknown = Reflect.get(state, "bytes");
	return typeof bytes === "number" && Number.isFinite(bytes) ? bytes : undefined;
}

function reporterSections(reporters: readonly NamedMemoryReporter[]): {
	sections: Record<string, Record<string, number>>;
	errors: Record<string, string>;
} {
	const sections: Record<string, Record<string, number>> = {};
	const errors: Record<string, string> = {};
	for (const { name, reporter } of reporters) {
		if (RESERVED_MEMORY_REPORT_KEYS.has(name) || name in sections || name in errors) continue;
		try {
			sections[name] = finiteFigures(reporter());
		} catch (error) {
			errors[name] = error instanceof Error ? error.message : String(error);
		}
	}
	return { sections, errors };
}

function finiteFigures(figures: unknown): Record<string, number> {
	if (typeof figures !== "object" || figures === null) return {};
	const kept: Record<string, number> = {};
	for (const [key, value] of Object.entries(figures)) {
		if (typeof value === "number" && Number.isFinite(value)) kept[key] = value;
	}
	return kept;
}
