type BunFfi = typeof import("bun:ffi");

let clearInherit: ((fd: number) => boolean) | undefined;

/** Synchronous receipt boundary, before any startup import can spawn an unrelated child. */
export function clearPrivateFdInherit(fd: number): boolean {
	if (clearInherit === undefined) {
		// Runtime boundary: Node must never resolve a Bun-only import.
		const ffi = process.getBuiltinModule("bun:ffi") as BunFfi | undefined;
		if (ffi === undefined) return false;
		// A HANDLE is pointer-sized, not a CRT fd. ptr preserves the full width on win64.
		const crt = ffi.dlopen("ucrtbase.dll", {
			_get_osfhandle: { args: [ffi.FFIType.i32], returns: ffi.FFIType.ptr },
		});
		const kernel = ffi.dlopen("kernel32.dll", {
			SetHandleInformation: { args: [ffi.FFIType.ptr, ffi.FFIType.u32, ffi.FFIType.u32], returns: ffi.FFIType.i32 },
		});
		clearInherit = (descriptor) => {
			const handle = crt.symbols._get_osfhandle(descriptor);
			return Boolean(handle) && kernel.symbols.SetHandleInformation(handle, 1, 0) === 1;
		};
	}
	return clearInherit(fd);
}
