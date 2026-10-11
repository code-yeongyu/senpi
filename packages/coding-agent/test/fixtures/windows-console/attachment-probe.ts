// Answers "does this pid own a console, and is that console's window visible?" (ported from
// oh-my-openagent's RPC console probe). It runs as a throwaway child on purpose: AttachConsole binds the
// calling process to the other process's console, so asking from the long-lived probe would attach the
// probe to the very console it measures.
import { dlopen, FFIType } from "bun:ffi";

const pid = Number.parseInt(process.argv[2] ?? "", 10);
if (!Number.isSafeInteger(pid) || pid <= 0) {
	throw new Error(`usage: attachment-probe.ts <pid> (got ${String(process.argv[2])})`);
}

const kernel32 = dlopen("kernel32.dll", {
	FreeConsole: { args: [], returns: FFIType.i32 },
	AttachConsole: { args: [FFIType.u32], returns: FFIType.i32 },
	GetConsoleWindow: { args: [], returns: FFIType.ptr },
	GetLastError: { args: [], returns: FFIType.u32 },
});
const user32 = dlopen("user32.dll", {
	IsWindowVisible: { args: [FFIType.ptr], returns: FFIType.i32 },
});

kernel32.symbols.FreeConsole();
const attached = kernel32.symbols.AttachConsole(pid) !== 0;
const errorCode = Number(kernel32.symbols.GetLastError());
const windowHandle = kernel32.symbols.GetConsoleWindow();
const windowHandleValue = Number(windowHandle ?? 0);
const windowVisible = windowHandleValue !== 0 && user32.symbols.IsWindowVisible(windowHandle) !== 0;
if (attached) kernel32.symbols.FreeConsole();
process.stdout.write(JSON.stringify({ attached, errorCode, windowHandle: windowHandleValue, windowVisible }));
