/**
 * Take the OSC 7577 token (senpi#7493) out of the environment before anything starts a child, so no tool, MCP server,
 * subagent, terminal session or extension process inherits it and registers a resume command of its own.
 *
 * RUNTIME BOUNDARY (same sanctioned dynamic import as `modes/interactive/stderr-fd-redirect.ts`): under Bun,
 * `delete process.env.X` leaves the libc environment untouched, which native children (the Rust PTY) inherit, so the
 * variable is also removed with `unsetenv` through `bun:ffi`. Node's delete already calls `unsetenv`.
 */
export async function takeProgramResumeToken(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
	const token = env.OSC7577_TOKEN;
	delete env.OSC7577_TOKEN;
	if (token !== undefined && env === process.env) await unsetLibcVariable("OSC7577_TOKEN");
	return token;
}

async function unsetLibcVariable(name: string, platform = process.platform): Promise<void> {
	if (platform !== "darwin" && platform !== "linux") return;
	if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") return;
	const { dlopen, FFIType } = await import("bun:ffi");
	try {
		const libc = dlopen(platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
			unsetenv: { args: [FFIType.cstring], returns: FFIType.i32 },
		});
		libc.symbols.unsetenv(Buffer.from(`${name}\0`));
		libc.close();
	} catch {
		// No usable libc: the JS-level delete above still covers every child spawned through process.env.
	}
}
