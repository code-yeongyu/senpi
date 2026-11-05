import type { Flock } from "./hand-activity-lock.ts";

type BunFfi = typeof import("bun:ffi");

let bound: Flock | null | undefined;

/**
 * `flock(2)` from libc through `bun:ffi`, with the errno it left read on the same thread right after the call.
 *
 * RUNTIME BOUNDARY: `bun:ffi` is a Bun-only builtin, reached with `process.getBuiltinModule`, which answers synchronously
 * on Bun and `undefined` on Node (as `core/process-footprint.ts` does). Node, win32, or a library or symbol this build
 * cannot bind all give `undefined`: the kernel-lock ruling's ENOSYS class, so a `run` holds no activity lock.
 */
export function loadFlock(): Flock | undefined {
	if (bound === undefined) bound = bindFlock() ?? null;
	return bound ?? undefined;
}

function bindFlock(): Flock | undefined {
	if (process.platform !== "darwin" && process.platform !== "linux") return undefined;
	const ffi = process.getBuiltinModule("bun:ffi") as BunFfi | undefined;
	if (ffi === undefined) return undefined;
	const errnoSymbol = process.platform === "darwin" ? "__error" : "__errno_location";
	try {
		const library = ffi.dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
			flock: { args: [ffi.FFIType.i32, ffi.FFIType.i32], returns: ffi.FFIType.i32 },
			[errnoSymbol]: { args: [], returns: ffi.FFIType.ptr },
		});
		const errnoPointer = library.symbols[errnoSymbol];
		return (fd, operation) => {
			const rc = Number(library.symbols.flock(fd, operation));
			if (rc === 0 || errnoPointer === undefined) return { rc, errno: 0 };
			const pointer = errnoPointer();
			return { rc, errno: typeof pointer === "number" && pointer !== 0 ? ffi.read.i32(pointer, 0) : -1 };
		};
	} catch {
		// A library or symbol this build cannot bind: no flock here, which is the ENOSYS class (no hold).
		return undefined;
	}
}
