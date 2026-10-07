const RUNTIME_METADATA = Symbol.for("senpi.extension.runtime.metadata");

type Metadata = (generation: string, filename: string) => unknown;

export function publishRuntimeMetadata(value: Metadata): void {
	(globalThis as Record<symbol, unknown>)[RUNTIME_METADATA] = value;
}

export const metadata: Metadata = (generation, filename) =>
	((globalThis as Record<symbol, unknown>)[RUNTIME_METADATA] as Metadata)(generation, filename);
