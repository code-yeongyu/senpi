/**
 * The one read of `bun:ffi` behind a guard: `process.getBuiltinModule` returns the module on Bun and
 * `undefined` on Node, so this module loads on either runtime, and only a result carrying the callable
 * surface the CPU readers bind is treated as FFI - the same boundary `display-js.ts` uses for `Bun`.
 */
export type BunFfi = {
	readonly dlopen: <S>(path: string, definitions: Record<string, unknown>) => { readonly symbols: S };
	readonly FFIType: Record<string, number>;
	readonly ptr: (buffer: ArrayBufferView) => number;
};

/** True when `value` carries the `bun:ffi` surface the kernel CPU readers use (`dlopen`, `FFIType`, `ptr`). */
export function isBunFfi(value: unknown): value is BunFfi {
	if (typeof value !== "object" || value === null) return false;
	if (!("dlopen" in value) || typeof value.dlopen !== "function") return false;
	if (!("ptr" in value) || typeof value.ptr !== "function") return false;
	return "FFIType" in value && typeof value.FFIType === "object" && value.FFIType !== null;
}

/** The runtime's `bun:ffi` module, or `undefined` on Node and on any runtime whose builtin is not one. */
export function loadBunFfi(): BunFfi | undefined {
	const ffi: unknown = process.getBuiltinModule("bun:ffi");
	return isBunFfi(ffi) ? ffi : undefined;
}
