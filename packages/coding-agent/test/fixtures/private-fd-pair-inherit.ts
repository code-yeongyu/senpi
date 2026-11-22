import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { preparePrivateFdSpawn } from "../../src/private-fd-spawn.ts";
import { takePrivateDescriptors } from "../../src/private-fds.ts";

const ffi = process.getBuiltinModule("bun:ffi") as typeof import("bun:ffi") | undefined;
if (ffi === undefined) throw new Error("private-fd-pair-inherit fixture must run under Bun");
const { FFIType, dlopen, ptr } = ffi;
const crt = dlopen("ucrtbase.dll", { _get_osfhandle: { args: [FFIType.i32], returns: FFIType.ptr } });
const kernel = dlopen("kernel32.dll", {
	OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
	GetHandleInformation: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
	DuplicateHandle: {
		args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.i32, FFIType.u32],
		returns: FFIType.i32,
	},
	CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
	GetFileInformationByHandleEx: {
		args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
		returns: FFIType.i32,
	},
});
const PROCESS_DUP_HANDLE = 0x40;
const HANDLE_FLAG_INHERIT = 1;
const DUPLICATE_SAME_ACCESS = 2;
const FILE_NAME_INFO = 2;

function inheritable(handle: number): boolean | null {
	const flags = new Uint32Array(1);
	if (kernel.symbols.GetHandleInformation(handle, ptr(flags)) === 0) return null;
	return ((flags[0] ?? 0) & HANDLE_FLAG_INHERIT) !== 0;
}

function pipeName(handle: number): string | null {
	const buffer = new Uint8Array(1024);
	if (kernel.symbols.GetFileInformationByHandleEx(handle, FILE_NAME_INFO, ptr(buffer), buffer.byteLength) === 0)
		return null;
	const length = new DataView(buffer.buffer).getUint32(0, true);
	return Buffer.from(buffer.subarray(4, 4 + length)).toString("utf16le");
}

const forward = takePrivateDescriptors();
const entry = forward.kind === "entries" ? forward.entries.get("a") : undefined;
if (!Array.isArray(entry)) throw new Error(`pair not adopted: ${JSON.stringify(entry)}`);
const adopted = entry.map((fd) => crt.symbols._get_osfhandle(fd));
// Control: the same pipe under an inheritable duplicate is what an uncleared adopted handle would look like.
const self = kernel.symbols.OpenProcess(PROCESS_DUP_HANDLE, 0, process.pid);
const duplicate = new BigUint64Array(1);
if (
	!self ||
	kernel.symbols.DuplicateHandle(self, adopted[0] ?? 0, self, ptr(duplicate), 0, 1, DUPLICATE_SAME_ACCESS) === 0
)
	throw new Error("control duplicate failed");
const control = Number(duplicate[0] ?? 0n);
const handles = [control, ...adopted];
process.stdout.write(
	`parent:${JSON.stringify({ inheritable: handles.map(inheritable), names: handles.map(pipeName) })}\n`,
);

// An ordinary child: inherited stdio, no table, no descriptor slots.
const probe = spawn(
	process.execPath,
	[join(import.meta.dirname, "private-fd-handle-probe.ts"), ...handles.map(String)],
	{
		stdio: "inherit",
	},
);
const [probeCode] = await once(probe, "exit");
kernel.symbols.CloseHandle(control);
kernel.symbols.CloseHandle(self);
if (probeCode !== 0) process.exit(3);

// The explicit hop must still receive both halves and round-trip through them.
const transfer = preparePrivateFdSpawn({ stdio: ["ignore", "inherit", "inherit"] }, {}, forward);
const engine = spawn(process.execPath, [join(import.meta.dirname, "private-fd-pair.ts"), "engine"], transfer.options);
transfer.close();
engine.once("error", () => process.exit(2));
engine.once("exit", (code) => process.exit(code ?? 2));
