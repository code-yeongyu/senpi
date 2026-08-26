import * as nodeModule from "node:module";

// Enabling the on-disk V8 code cache trades a little startup IO for skipped compilation of the
// CLI's large module graph. Node does not export NODE_COMPILE_CACHE into process.env when the
// programmatic API turns the cache on, so a spawned child would otherwise resolve its own cache
// directory and re-pay the compile cost. `cli.ts` runs the real engine as a child process, so
// publishing the directory is what makes the cache reach the process that actually loads the graph.
//
// The value published must be the BASE directory reported by enableCompileCache(), not
// getCompileCacheDir(): the latter already includes Node's <version>-<arch>-<hash>-<uid> segment,
// and handing it back through the environment makes the child nest a second segment inside it,
// so it would miss every entry the parent wrote.
//
// The API is read off the namespace rather than imported by name on purpose: a named import of an
// export the runtime does not provide is a link-time SyntaxError, which no runtime guard can catch.
// The bun-compiled binary (dist/pi) runs this file, so the lookup has to stay late-bound.
export function enableStartupCompileCache(): void {
	const enable = (nodeModule as Partial<typeof nodeModule>).enableCompileCache;
	if (typeof enable !== "function") {
		return;
	}
	// A cache directory that cannot be created (read-only or sandboxed HOME/TMPDIR) must not break
	// startup: the cache is an optimization, so every failure degrades to plain compilation.
	try {
		const result = enable();
		if (result.directory !== undefined && process.env.NODE_COMPILE_CACHE === undefined) {
			process.env.NODE_COMPILE_CACHE = result.directory;
		}
	} catch {
		// Startup must never fail because the code cache is unavailable.
	}
}
