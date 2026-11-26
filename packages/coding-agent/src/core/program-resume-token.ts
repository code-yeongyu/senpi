import { closeSync, readSync, writeSync } from "node:fs";

const TOKEN = "OSC7577_TOKEN";
/** `<pid>:<fd>`: the read end of the pipe that carries the token across the hand-off exec, valid only in that pid. */
const HANDOFF = "SENPI_OSC7577_TOKEN_HANDOFF";
const HANDED_OFF = Symbol.for("senpi.programResumeTokenHandoff.v1");
const TOKEN_READ_LIMIT = 4096;
const LIBC = { darwin: "libSystem.B.dylib", linux: "libc.so.6" } as const;

/**
 * Take the OSC 7577 token (senpi#7493) out of the environment before anything starts a child, so no tool, MCP server,
 * subagent, terminal session or extension process inherits it and registers a resume command of its own.
 *
 * Under Bun this is only complete after {@link handOffProgramResumeToken}: `delete` and `unsetenv` do not reach the
 * startup environment Bun keeps for `Bun.spawn`/`spawnSync` without an `env` and for every Worker's copy. On the
 * fallback path (Windows, no libc, a failed exec) the delete still covers `node:child_process` and `Bun.$`, and the
 * libc `unsetenv` (RUNTIME BOUNDARY, same sanctioned dynamic import as `modes/interactive/stderr-fd-redirect.ts`)
 * covers native children such as the Rust PTY. Node's delete already calls `unsetenv`, and Node workers copy the
 * current `process.env`.
 */
export async function takeProgramResumeToken(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
	const token = env[TOKEN];
	delete env[TOKEN];
	if (token !== undefined && env === process.env) await unsetLibcVariable(TOKEN);
	return token;
}

/**
 * Under Bun on darwin/linux, re-execute this process in place (same pid, same argv) without `OSC7577_TOKEN` in its
 * environment, handing the token over a pipe, so the startup environment that Bun's children and Workers copy never
 * holds it. The receiving image puts the token back into `process.env` only, where {@link takeProgramResumeToken}
 * takes it as before. Runs at most once per process, at the first call: it must be the first statement of the
 * process entry, because everything evaluated before it runs a second time (`program-resume-startup.ts` is the CLI's
 * first import; an embedding entry that runs code before loading the CLI calls this first itself).
 */
export async function handOffProgramResumeToken(env: NodeJS.ProcessEnv = process.env): Promise<void> {
	if (Reflect.get(globalThis, HANDED_OFF) === true) return;
	Object.defineProperty(globalThis, HANDED_OFF, { value: true });
	if (receiveHandedOffToken(env)) return;
	const token = env[TOKEN];
	const platform = process.platform;
	if (token === undefined || typeof (globalThis as { Bun?: unknown }).Bun === "undefined") return;
	if (platform !== "darwin" && platform !== "linux") return;
	const argv = relaunchArgv();
	if (argv === undefined) return;
	await execWithoutToken(platform, token, argv, env);
}

function receiveHandedOffToken(env: NodeJS.ProcessEnv): boolean {
	const handoff = env[HANDOFF];
	if (handoff === undefined) return false;
	delete env[HANDOFF];
	const match = /^(\d+):(\d+)$/.exec(handoff);
	// A child inherits the variable but never the pipe: only the process that exec'd itself (same pid) reads it.
	if (match === null || Number(match[1]) !== process.pid) return false;
	const fd = Number(match[2]);
	try {
		const buffer = Buffer.alloc(TOKEN_READ_LIMIT);
		const length = readSync(fd, buffer);
		if (length > 0) env[TOKEN] = buffer.toString("utf8", 0, length);
	} finally {
		closeSync(fd);
	}
	return true;
}

/** The argv this process was started with. A compiled binary reports its embedded entry as argv[1], which the OS never saw. */
function relaunchArgv(): string[] | undefined {
	const [, entry, ...rest] = process.argv;
	if (entry === undefined) return undefined;
	if (entry.startsWith("/$bunfs/")) return [process.argv0, ...rest];
	return [process.argv0, ...process.execArgv, entry, ...rest];
}

async function execWithoutToken(
	platform: keyof typeof LIBC,
	token: string,
	argv: readonly string[],
	env: NodeJS.ProcessEnv,
): Promise<void> {
	const { dlopen, FFIType, ptr } = await import("bun:ffi");
	const openLibc = () => {
		try {
			// libc's execve, not process.execve: Bun's closes every descriptor above 2, which would drop the pipe.
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
	const childEnv: Record<string, string> = {};
	for (const [name, value] of Object.entries(env)) if (value !== undefined && name !== TOKEN) childEnv[name] = value;
	childEnv[HANDOFF] = `${process.pid}:${readFd}`;
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
	const file = cString(process.execPath);
	const argvTable = pointerTable(argv);
	const envTable = pointerTable(Object.entries(childEnv).map(([name, value]) => `${name}=${value}`));
	libc.symbols.execve(ptr(file), ptr(argvTable), ptr(envTable));
	// Reached only when the exec failed: this process keeps running with the token, and takeProgramResumeToken()
	// still removes it from process.env and libc at main().
	closeSync(readFd);
}

async function unsetLibcVariable(name: string, platform = process.platform): Promise<void> {
	if (platform !== "darwin" && platform !== "linux") return;
	if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") return;
	const { dlopen, FFIType, ptr } = await import("bun:ffi");
	try {
		const libc = dlopen(platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
			unsetenv: { args: [FFIType.ptr], returns: FFIType.i32 },
		});
		const cName = Buffer.from(`${name}\0`, "utf8");
		libc.symbols.unsetenv(ptr(cName));
	} catch {
		// No usable libc: the JS-level delete above still covers every child spawned through process.env.
	}
}
