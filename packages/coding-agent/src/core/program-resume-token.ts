const TOKEN = "OSC7577_TOKEN";

/**
 * Take the OSC 7577 token (senpi#7493) out of the environment before anything starts a child, so no tool, MCP server,
 * subagent, terminal session or extension process inherits it and registers a resume command of its own.
 *
 * Under Bun this is only complete after the in-place exec of `private-fd-token-handoff.ts`: `delete` and `unsetenv`
 * do not reach the startup environment Bun keeps for `Bun.spawn`/`spawnSync` without an `env` and for every Worker's
 * copy. Where that exec does not run (Windows, a launch that was handed descriptors, a failed exec) the delete still
 * covers `node:child_process` and `Bun.$`, and the libc `unsetenv` (RUNTIME BOUNDARY, same sanctioned dynamic import
 * as `modes/interactive/stderr-fd-redirect.ts`) covers native children such as the Rust PTY. Node's delete already
 * calls `unsetenv`, and Node workers copy the current `process.env`.
 */
export async function takeProgramResumeToken(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
	const token = env[TOKEN];
	delete env[TOKEN];
	if (token !== undefined && env === process.env) await unsetLibcVariable(TOKEN);
	return token;
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
