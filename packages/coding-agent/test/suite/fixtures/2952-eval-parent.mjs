// Regression harness for senpi#2952: the CLI entry, loaded from a `node -e`
// caller, must not replay the caller's eval code when it re-launches itself
// in an isolated process. The spawned entry is redirected to the receipt
// fixture (2952-eval-child-entry.mjs) the same way 2599-eval-parent.mjs does.
import childProcess from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = process.env.SENPI_ARGV_REPRO_ROOT;
const kind = process.env.SENPI_ARGV_REPRO_CASE;
const countFile = join(root, "caller.log");
appendFileSync(countFile, "caller\n");

if (process.env.SENPI_ARGV_REPRO_PARENT_PID) {
	// A replayed caller: count it, then wait to be killed. The outermost
	// parent's receipt deadline is what fails the test on unfixed code.
	await new Promise(() => {});
} else {
	process.env.SENPI_ARGV_REPRO_PARENT_PID = String(process.pid);
	const entry = fileURLToPath(new URL("./2952-eval-child-entry.mjs", import.meta.url));
	const originalSpawn = childProcess.spawn;
	const ready = Promise.withResolvers();
	const children = [];
	const exits = [];
	const deadline = setTimeout(() => ready.reject(new Error("No child execution receipt")), 30_000);
	let launchArgs = null;
	childProcess.spawn = (command, args, options) => {
		const index = args.findIndex((arg) => /(?:^|[/\\])cli(?:-main)?\.(?:ts|js)$/.test(arg));
		if (index < 0) return originalSpawn(command, args, options);
		launchArgs = [...args];
		const launch = [...args];
		launch[index] = entry;
		const stdio = Array.isArray(options?.stdio) ? [...options.stdio] : ["inherit", "inherit", "inherit"];
		while (stdio.length < 4) stdio.push("ignore");
		stdio[3] = "ipc";
		const child = originalSpawn(command, launch, { ...options, stdio });
		children.push(child);
		exits.push(new Promise((resolve) => child.once("close", resolve)));
		child.once("error", (error) => ready.reject(error));
		child.once("message", (message) => ready.resolve(message));
		return child;
	};
	syncBuiltinESMExports();
	if (process.env.SENPI_ARGV_REPRO_BUNDLED === "1") {
		// The bundled entry reads the compile-time PI_BUNDLED_NODE global; under
		// tsx it is unset, so the fixture defines it before importing cli.ts.
		globalThis.PI_BUNDLED_NODE = true;
	}
	let receipt;
	let launchError;
	try {
		try {
			await import(pathToFileURL(fileURLToPath(new URL("../../../src/cli.ts", import.meta.url))).href);
		} catch (error) {
			launchError = error.message;
		}
		if (launchError !== undefined && children.length === 0) throw new Error(launchError);
		receipt = await ready.promise;
	} finally {
		for (const child of children) {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
		}
		await Promise.all(exits);
		clearTimeout(deadline);
		childProcess.spawn = originalSpawn;
		syncBuiltinESMExports();
	}
	writeFileSync(
		join(root, "result.json"),
		JSON.stringify({
			callerCount: readFileSync(countFile, "utf8").trim().split("\n").length,
			receipt,
			launchArgs,
			launchError: launchError ?? null,
			childrenSettled: children.every((child) => child.exitCode !== null || child.signalCode !== null),
		}),
	);
}
