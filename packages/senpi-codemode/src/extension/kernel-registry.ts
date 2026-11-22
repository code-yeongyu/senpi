import type { EvalLanguage } from "../tool/types.ts";

/** `heap`: a JS worker's own heap estimate; `footprint`: the interpreter process's memory footprint. */
export type KernelMeasure = "heap" | "footprint";

export interface KernelMemoryReading {
	readonly liveBytes: number;
	readonly measure: KernelMeasure;
}

/**
 * What the registry reads from a live kernel. It is backed by the kernel object, not its worker or
 * process, so a kernel that restarts its worker (ceiling, crash, reset) keeps its registry entry.
 */
export interface RegisteredKernelSource {
	readonly measure: KernelMeasure;
	/** The last reading the host holds, without asking the kernel; `undefined` before the first one. */
	lastLiveBytes(): number | undefined;
	/** A cell is running, so the last reading may predate what the kernel holds now. */
	busy(): boolean;
	/** A fresh reading taken without running a cell; `undefined` when no worker or process is live. */
	queryMemory(): Promise<KernelMemoryReading | undefined>;
	pid?(): number | undefined;
}

export interface KernelRegistration {
	readonly id: string;
	readonly sessionId: string;
	readonly language: EvalLanguage;
	readonly source: RegisteredKernelSource;
}

export interface KernelListing {
	readonly id: string;
	readonly sessionId: string;
	readonly language: EvalLanguage;
	readonly measure: KernelMeasure;
	readonly lastLiveBytes?: number;
	readonly busy: boolean;
	readonly pid?: number;
}

export interface KernelRegistry {
	register(kernel: KernelRegistration): void;
	unregister(id: string): boolean;
	list(): KernelListing[];
	lastLiveBytes(id: string): number | undefined;
	query(id: string): Promise<KernelMemoryReading | undefined>;
}

// One registry per process, whichever copy of this module asks: the extension loader can evaluate the
// codemode module graph more than once in a process, and the host's memory report reads the same key.
const REGISTRY_KEY = Symbol.for("senpi.codemode.kernel-registry");

function createKernelRegistry(): KernelRegistry {
	const kernels = new Map<string, KernelRegistration>();
	return {
		register(kernel) {
			kernels.set(kernel.id, kernel);
		},
		unregister(id) {
			return kernels.delete(id);
		},
		list() {
			return [...kernels.values()].map(listing);
		},
		lastLiveBytes(id) {
			return kernels.get(id)?.source.lastLiveBytes();
		},
		async query(id) {
			return await kernels.get(id)?.source.queryMemory();
		},
	};
}

function listing({ id, sessionId, language, source }: KernelRegistration): KernelListing {
	const lastLiveBytes = source.lastLiveBytes();
	const pid = source.pid?.();
	return {
		id,
		sessionId,
		language,
		measure: source.measure,
		busy: source.busy(),
		...(lastLiveBytes === undefined ? {} : { lastLiveBytes }),
		...(pid === undefined ? {} : { pid }),
	};
}

function isKernelRegistry(value: unknown): value is KernelRegistry {
	if (typeof value !== "object" || value === null) return false;
	return ["register", "unregister", "list", "lastLiveBytes", "query"].every(
		(name) => typeof Reflect.get(value, name) === "function",
	);
}

function processKernelRegistry(): KernelRegistry {
	const existing: unknown = Reflect.get(globalThis, REGISTRY_KEY);
	if (isKernelRegistry(existing)) return existing;
	const created = createKernelRegistry();
	Reflect.set(globalThis, REGISTRY_KEY, created);
	return created;
}

export const kernelRegistry: KernelRegistry = processKernelRegistry();
