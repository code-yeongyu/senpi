import { fstatSync } from "node:fs";

type BunFfi = typeof import("bun:ffi");

let clearInherit: ((fd: number) => boolean) | undefined;

/** A native loader that failed once stays failed for the process: the clear fails closed without reloading (senpi#4873). */
const failClosed = (): boolean => false;

function loadClearInherit(): (fd: number) => boolean {
	// Runtime boundary: Node must never resolve a Bun-only import.
	const ffi = process.getBuiltinModule("bun:ffi") as BunFfi | undefined;
	if (ffi === undefined) return failClosed;
	// A HANDLE is pointer-sized, not a CRT fd. ptr preserves the full width on win64.
	const crt = ffi.dlopen("ucrtbase.dll", {
		_get_osfhandle: { args: [ffi.FFIType.i32], returns: ffi.FFIType.ptr },
	});
	const kernel = ffi.dlopen("kernel32.dll", {
		SetHandleInformation: {
			args: [ffi.FFIType.ptr, ffi.FFIType.u32, ffi.FFIType.u32],
			returns: ffi.FFIType.i32,
		},
	});
	const width = process.arch === "ia32" || process.arch === "arm" ? 32 : 64;
	// INVALID_HANDLE_VALUE (-1) and _NO_CONSOLE_FILENO (-2, descriptors 0-2 without a console), signed and unsigned.
	const invalid = new Set([-1n, -2n, BigInt.asUintN(width, -1n), BigInt.asUintN(width, -2n)]);
	// A number pointer of full width rounds when widened, so compare it as a number too.
	const invalidNumbers = new Set([...invalid].map((value) => Number(value)));
	return (descriptor) => {
		const handle = crt.symbols._get_osfhandle(descriptor);
		if (!handle) return false;
		const pointer = BigInt(handle);
		if (invalid.has(pointer) || (typeof handle === "number" && invalidNumbers.has(handle))) return false;
		return kernel.symbols.SetHandleInformation(handle, 1, 0) === 1;
	};
}

/** Synchronous receipt boundary, before any startup import can spawn an unrelated child. */
export function clearPrivateFdInherit(fd: number): boolean {
	try {
		// The CRT invalid-parameter handler terminates the process for an unopened descriptor.
		fstatSync(fd);
		if (clearInherit === undefined) {
			try {
				clearInherit = loadClearInherit();
			} catch {
				clearInherit = failClosed;
			}
		}
		return clearInherit(fd);
	} catch {
		return false;
	}
}
