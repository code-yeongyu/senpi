import * as nodeModule from "node:module";
import {
	CONFIG_COMMAND_ARGV,
	HOST_COMMAND_ARGV,
	isPackageCommandArgv,
	SCHEDULE_COMMAND_ARGV,
} from "./cli/deferred-commands.ts";

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
export async function enableStartupCompileCache(): Promise<void> {
	const enable = (nodeModule as Partial<typeof nodeModule>).enableCompileCache;
	if (typeof enable !== "function") {
		return;
	}
	const args = process.argv.slice(2);
	// Match cli.ts's engine-free root version fast path, even for flag-like option values.
	if (
		!isPackageCommandArgv(args) &&
		args[0] !== CONFIG_COMMAND_ARGV &&
		(args.includes("--version") || args.includes("-v"))
	) {
		return;
	}
	let scheduleWatch = false;
	if (args[0] === SCHEDULE_COMMAND_ARGV && args[1] === "run") {
		for (let index = 2; index < args.length; index++) {
			const arg = args[index];
			if (arg === "--watch") scheduleWatch = true;
			else if (["--exec", "--poll-seconds", "--timeout-seconds", "--concurrency"].includes(arg ?? "")) index++;
		}
	}
	if (
		isPackageCommandArgv(args) ||
		args[0] === HOST_COMMAND_ARGV ||
		(args[0] === SCHEDULE_COMMAND_ARGV && !scheduleWatch)
	) {
		return;
	}
	if (
		!scheduleWatch &&
		args.some((arg) => ["--help", "-h", "--export", "--list-models", "--list-tips"].includes(arg))
	) {
		// Bun writes the cold cache at exit, making metadata-only launches slower (#3166).
		// Parse only candidate invocations: ordinary sessions enable the cache before loading
		// even the argument parser, while flag-like prompt/option values still retain caching.
		try {
			const { parseArgs } = await import("./cli/args.ts");
			const parsed = parseArgs(args);
			if (
				parsed.version ||
				parsed.export ||
				parsed.listModels !== undefined ||
				parsed.listTips ||
				(parsed.help && !(parsed.mode === "rpc" && parsed.multiSession))
			) {
				return;
			}
		} catch {
			// The decision is only an optimization. On parse/import failure enable as before;
			// the real CLI owns argument errors and must retain its existing output and exit code.
		}
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
