import { closeSync, fstatSync, readSync, writeSync } from "node:fs";
import { HOST_STARTUP_EVENTS_ENV, HOST_WATCH_ENV_NAMES } from "./modes/rpc/host-identity-env.ts";
import { PRIVATE_FDS_TABLE_ENV } from "./private-fd-table.ts";

/**
 * The OSC 7577 token hand-off (senpi#7493), part of the private-descriptor contract because it creates, passes and
 * closes a descriptor across an exec.
 *
 * Under Bun, `delete`/`unsetenv` never reach the startup environment Bun keeps for `Bun.spawn`/`spawnSync` without an
 * `env` and for every Worker's copy. So on darwin/linux, when `OSC7577_TOKEN` is set, the process re-executes itself in
 * place (libc `execve`: same pid, same argv) with the token removed from its environment and written to a pipe. The
 * new image learns the pipe from one argv element, `--senpi-osc7577-token-fd=<fd>`, placed right after the entry and
 * removed from `process.argv` before anything reads it. argv is never inherited, so no child can name that descriptor.
 *
 * Bun marks every inherited descriptor close-on-exec at startup, so the exec would drop whatever a launcher handed
 * this process. The hand-off is therefore skipped whenever a launcher signals a descriptor (the private-fd table, the
 * host startup pipe, the host watch binding, `--owner-fd`, `--mcp-presenter-fd`); those launches keep the previous
 * delete+unsetenv behaviour. Bun's own `process.execve` is not used because it closes every descriptor above 2.
 */
const TOKEN = "OSC7577_TOKEN";
const FLAG = "--senpi-osc7577-token-fd=";
const HANDED_OFF = Symbol.for("senpi.programResumeTokenHandoff.v1");
const TOKEN_READ_LIMIT = 4096;
const LIBC = { darwin: "libSystem.B.dylib", linux: "libc.so.6" } as const;
const DESCRIPTOR_ENV = [PRIVATE_FDS_TABLE_ENV, HOST_STARTUP_EVENTS_ENV, ...HOST_WATCH_ENV_NAMES];
const DESCRIPTOR_FLAGS = ["--owner-fd", "--mcp-presenter-fd"];

/**
 * Runs at most once per process, at the first call, and must be the first statement of the process entry: everything
 * evaluated before it runs again after the exec. `program-resume-startup.ts` is the first import of both CLI entries;
 * an embedding entry that runs code before loading the CLI calls this first itself.
 */
export async function handOffProgramResumeToken(
	env: NodeJS.ProcessEnv = process.env,
	argv: string[] = process.argv,
): Promise<void> {
	if (Reflect.get(globalThis, HANDED_OFF) === true) return;
	Object.defineProperty(globalThis, HANDED_OFF, { value: true });
	if (receiveHandedOffToken(env, argv)) return;
	const token = env[TOKEN];
	const platform = process.platform;
	if (token === undefined || typeof (globalThis as { Bun?: unknown }).Bun === "undefined") return;
	if (platform !== "darwin" && platform !== "linux") return;
	if (DESCRIPTOR_ENV.some((name) => env[name] !== undefined)) return;
	if (argv.some((arg) => DESCRIPTOR_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`)))) return;
	const relaunch = relaunchArgv(argv);
	if (relaunch === undefined) return;
	await execWithoutToken(platform, token, relaunch, env);
}

/** Only the element right after the entry counts, and only a pipe is read: anything else is dropped unread. */
function receiveHandedOffToken(env: NodeJS.ProcessEnv, argv: string[]): boolean {
	const marker = argv[2];
	if (marker === undefined || !marker.startsWith(FLAG)) return false;
	argv.splice(2, 1);
	const text = marker.slice(FLAG.length);
	if (!/^\d+$/.test(text)) return true;
	const fd = Number(text);
	try {
		if (!fstatSync(fd).isFIFO()) return true;
	} catch {
		return true;
	}
	try {
		const buffer = Buffer.alloc(TOKEN_READ_LIMIT);
		const length = readSync(fd, buffer);
		if (length > 0) env[TOKEN] = buffer.toString("utf8", 0, length);
	} finally {
		closeSync(fd);
	}
	return true;
}

/**
 * The argv the OS started this process with. A compiled binary reports its embedded entry as argv[1], which the OS
 * never saw. `--cwd` is dropped because Bun already applied it: the process now runs in that directory, and a relative
 * value would be resolved a second time.
 */
function relaunchArgv(argv: readonly string[]): { readonly args: string[]; readonly markerAt: number } | undefined {
	const [, entry, ...rest] = argv;
	if (entry === undefined) return undefined;
	if (entry.startsWith("/$bunfs/")) return { args: [process.argv0, ...rest], markerAt: 1 };
	const runtimeArgs: string[] = [];
	for (let index = 0; index < process.execArgv.length; index++) {
		const arg = process.execArgv[index] ?? "";
		if (arg === "--cwd") index++;
		else if (!arg.startsWith("--cwd=")) runtimeArgs.push(arg);
	}
	return { args: [process.argv0, ...runtimeArgs, entry, ...rest], markerAt: runtimeArgs.length + 2 };
}

async function execWithoutToken(
	platform: keyof typeof LIBC,
	token: string,
	relaunch: { readonly args: string[]; readonly markerAt: number },
	env: NodeJS.ProcessEnv,
): Promise<void> {
	const { dlopen, FFIType, ptr } = await import("bun:ffi");
	const openLibc = () => {
		try {
			return dlopen(LIBC[platform], {
				pipe: { args: [FFIType.ptr], returns: FFIType.i32 },
				execve: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
			});
		} catch {
			return undefined;
		}
	};
	const libc = openLibc();
	if (libc === undefined) return;
	const fds = new Int32Array(2);
	if (libc.symbols.pipe(ptr(fds)) !== 0) return;
	const [readFd, writeFd] = [fds[0], fds[1]];
	// A token is far below PIPE_BUF, so this write never blocks and is read whole.
	writeSync(writeFd, token);
	closeSync(writeFd);
	const args = [...relaunch.args];
	args.splice(relaunch.markerAt, 0, `${FLAG}${readFd}`);
	const strings: Buffer[] = [];
	const cString = (text: string) => {
		const bytes = Buffer.from(`${text}\0`, "utf8");
		strings.push(bytes);
		return bytes;
	};
	const pointerTable = (items: readonly string[]) => {
		const table = new BigUint64Array(items.length + 1);
		items.forEach((item, index) => {
			table[index] = BigInt(ptr(cString(item)));
		});
		return table;
	};
	const childEnv = Object.entries(env).flatMap(([name, value]) =>
		value === undefined || name === TOKEN ? [] : [`${name}=${value}`],
	);
	libc.symbols.execve(ptr(cString(process.execPath)), ptr(pointerTable(args)), ptr(pointerTable(childEnv)));
	// Reached only when the exec failed: this process keeps the token, and takeProgramResumeToken() still removes it
	// from process.env and libc at main().
	closeSync(readFd);
}
