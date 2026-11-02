/**
 * Process-table access for the host child reaper.
 *
 * Three operations, each with exactly one job:
 *   - `listDirectChildren` enumerates the DIRECT children of this process
 *     (darwin: libproc `proc_listchildpids`, which lists zombies too; linux:
 *     a `/proc/<pid>/stat` ppid scan). Never a `ps` spawn - a reaper that
 *     spawns children to find children is the bug it is meant to fix (#1507).
 *   - `isWaitable` is the ORACLE: `waitid(P_PID, pid, WEXITED|WNOHANG|WNOWAIT)`
 *     peeks at the exit status WITHOUT consuming it, so an observation never
 *     steals a child from the thread that owns it. `proc_pidinfo` is NOT used
 *     for this: it reports nothing trustworthy about a zombie.
 *   - `reapExited` consumes exactly one pid with `waitpid(pid, WNOHANG)`.
 *     `waitpid(-1, ...)` is never called: it would steal an arbitrary child
 *     from whichever thread was waiting for it.
 *
 * RUNTIME BOUNDARY (the repository's one sanctioned reason for a dynamic
 * import, same shape as `ownership-safe-lock.ts`'s `bun:sqlite` loader): the
 * bindings need `bun:ffi`, a Bun-only builtin. A TOP-LEVEL import of it makes
 * this module - and therefore every host that reaches it - unloadable on Node
 * (`ERR_UNSUPPORTED_ESM_URL_SCHEME: Received protocol 'bun:'`, verified). The
 * specifier is therefore imported behind the runtime gate in
 * `loadChildReaperSyscalls`, which resolves to `undefined` on Node so the
 * reaper turns itself off with one warning. Everything else here is top-level.
 */
import { readdirSync, readFileSync } from "node:fs";

/** The process-table operations the reaper needs; one implementation per platform. */
export interface ChildReaperSyscalls {
	listDirectChildren(): readonly number[];
	/** True when the child has exited and its status is still unclaimed. */
	isWaitable(pid: number): boolean;
	/** True when THIS call consumed the child's exit status. */
	reapExited(pid: number): boolean;
	/** Executable name while the child is alive; "" once the kernel dropped it. */
	describe(pid: number): string;
}

/** waitid/waitpid option bits and idtype, which differ between the two platforms. */
const P_PID = 1;
const WNOHANG = 0x01;
const WEXITED = 0x04;
const WNOWAIT = { darwin: 0x20, linux: 0x0100_0000 } as const;
/** Byte offset of `si_pid` inside `siginfo_t` (darwin packs it right after si_code). */
const SI_PID_OFFSET = { darwin: 12, linux: 16 } as const;
/** A host with more live children than this is pathological; the scan stays bounded. */
const MAX_TRACKED_CHILDREN = 4096;

type SupportedPlatform = keyof typeof WNOWAIT;

function supportedPlatform(platform: string): SupportedPlatform | undefined {
	return platform === "darwin" || platform === "linux" ? platform : undefined;
}

/**
 * Loads the platform bindings, or `undefined` when this runtime cannot reap
 * (Node, Windows, or a libc without the symbols). The platform and the runtime
 * are both decided BEFORE the `bun:ffi` specifier is reached, so a Node or
 * win32 host never asks its loader for a module it cannot resolve.
 */
export async function loadChildReaperSyscalls(platform = process.platform): Promise<ChildReaperSyscalls | undefined> {
	const supported = supportedPlatform(platform);
	if (supported === undefined) return undefined;
	if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") return undefined;
	const { dlopen, FFIType, ptr } = await import("bun:ffi");
	const library = supported === "darwin" ? "libSystem.B.dylib" : "libc.so.6";
	const wait = dlopen(library, {
		waitid: { args: [FFIType.i32, FFIType.u32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
		waitpid: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	});
	const info = new Uint8Array(512);
	const infoView = new DataView(info.buffer);
	const status = new Int32Array(1);
	const peekOptions = WEXITED | WNOHANG | WNOWAIT[supported];
	const siPidOffset = SI_PID_OFFSET[supported];
	return {
		listDirectChildren: supported === "darwin" ? darwinChildren(dlopen, FFIType, ptr) : linuxChildren,
		isWaitable(pid) {
			// Zeroed before every call: with WNOHANG the kernel leaves si_pid at 0
			// when the child has not exited, and that is the whole signal.
			info.fill(0);
			const result = wait.symbols.waitid(P_PID, pid, ptr(info), peekOptions);
			return result === 0 && infoView.getInt32(siPidOffset, true) === pid;
		},
		reapExited(pid) {
			if (pid <= 0) throw new Error(`child reaper refuses to wait on pid ${pid}`);
			return wait.symbols.waitpid(pid, ptr(status), WNOHANG) === pid;
		},
		describe: supported === "darwin" ? darwinName(dlopen, FFIType, ptr) : linuxName,
	};
}

// libproc lives in the same library as `waitid`, but its symbols exist only on
// darwin: opening it per concern keeps each platform's symbol map exact (dlopen
// returns the already-loaded handle, so this costs nothing at runtime).
type Dlopen = Awaited<typeof import("bun:ffi")>["dlopen"];
type FFITypes = Awaited<typeof import("bun:ffi")>["FFIType"];
type Ptr = Awaited<typeof import("bun:ffi")>["ptr"];

function darwinChildren(dlopen: Dlopen, FFIType: FFITypes, ptr: Ptr): () => readonly number[] {
	const libproc = dlopen("libSystem.B.dylib", {
		proc_listchildpids: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	});
	const pids = new Int32Array(MAX_TRACKED_CHILDREN);
	return () => {
		const found = libproc.symbols.proc_listchildpids(process.pid, ptr(pids), pids.byteLength);
		return found <= 0 ? [] : Array.from(pids.subarray(0, Math.min(found, pids.length)));
	};
}

function darwinName(dlopen: Dlopen, FFIType: FFITypes, ptr: Ptr): (pid: number) => string {
	const libproc = dlopen("libSystem.B.dylib", {
		proc_name: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
	});
	const name = new Uint8Array(256);
	const decoder = new TextDecoder();
	return (pid) => {
		name.fill(0);
		const written = libproc.symbols.proc_name(pid, ptr(name), name.length);
		return written <= 0 ? "" : decoder.decode(name.subarray(0, written));
	};
}

/** `/proc/<pid>/stat` field 4 is the parent pid; zombies keep their entry. */
function linuxChildren(): readonly number[] {
	const children: number[] = [];
	for (const entry of readdirSync("/proc")) {
		const pid = Number(entry);
		if (!Number.isInteger(pid) || pid <= 0) continue;
		if (parentOf(pid) === process.pid) children.push(pid);
		if (children.length >= MAX_TRACKED_CHILDREN) break;
	}
	return children;
}

function linuxStat(pid: number): string | undefined {
	try {
		return readFileSync(`/proc/${pid}/stat`, "utf8");
	} catch {
		// The process exited between the directory listing and this read.
		return undefined;
	}
}

function parentOf(pid: number): number | undefined {
	// comm is parenthesised and may contain spaces, so parse after its last ')'.
	const stat = linuxStat(pid);
	const tail = stat?.slice(stat.lastIndexOf(")") + 2).split(" ");
	return tail === undefined ? undefined : Number(tail[1]);
}

function linuxName(pid: number): string {
	const stat = linuxStat(pid);
	const open = stat?.indexOf("(") ?? -1;
	const close = stat?.lastIndexOf(")") ?? -1;
	return stat === undefined || open === -1 || close <= open ? "" : stat.slice(open + 1, close);
}
