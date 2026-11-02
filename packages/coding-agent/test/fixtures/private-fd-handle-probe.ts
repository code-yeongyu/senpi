// An ordinary child: it receives no descriptor table and no stdio slots, only handle values as text.
// For each value it reports whether that value names a live handle here, and which pipe it is.
const ffi = process.getBuiltinModule("bun:ffi") as typeof import("bun:ffi") | undefined;
if (ffi === undefined) throw new Error("private-fd-handle-probe fixture must run under Bun");
const { FFIType, dlopen, ptr } = ffi;
const kernel = dlopen("kernel32.dll", {
	GetHandleInformation: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
	GetFileInformationByHandleEx: {
		args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
		returns: FFIType.i32,
	},
});

const FILE_NAME_INFO = 2;

function pipeName(handle: number): string | null {
	const buffer = new Uint8Array(1024);
	if (kernel.symbols.GetFileInformationByHandleEx(handle, FILE_NAME_INFO, ptr(buffer), buffer.byteLength) === 0)
		return null;
	const length = new DataView(buffer.buffer).getUint32(0, true);
	return Buffer.from(buffer.subarray(4, 4 + length)).toString("utf16le");
}

const report = process.argv.slice(2).map((value) => {
	const handle = Number(value);
	const flags = new Uint32Array(1);
	const valid = kernel.symbols.GetHandleInformation(handle, ptr(flags)) !== 0;
	return { valid, name: valid ? pipeName(handle) : null };
});
process.stdout.write(`probe:${JSON.stringify(report)}\n`);
