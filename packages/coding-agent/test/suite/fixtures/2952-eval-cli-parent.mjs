import childProcess from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = process.env.SENPI_ARGV_REPRO_ROOT;
const cliEntry = process.env.SENPI_ARGV_REPRO_CLI_ENTRY;
const countFile = join(root, "caller.log");
appendFileSync(countFile, "caller\n");

if (process.env.SENPI_ARGV_REPRO_PARENT_PID) {
	process.send({ kind: "caller-replayed" }, () => {
		process.disconnect();
		process.exitCode = 7;
	});
} else {
	process.env.SENPI_ARGV_REPRO_PARENT_PID = String(process.pid);
	const target = fileURLToPath(new URL("./2599-eval-child-entry.mjs", import.meta.url));
	const originalSpawn = childProcess.spawn;
	const ready = Promise.withResolvers();
	const expired = Promise.withResolvers();
	const children = [];
	const exits = [];
	const markers = [];
	const deadline = setTimeout(() => expired.reject(new Error("No child execution receipt")), 60_000);
	childProcess.spawn = (command, args, options) => {
		const index = args.findIndex((arg) => arg === cliEntry || /(?:^|[/\\])cli-main\.(?:ts|js)$/.test(arg));
		if (index < 0) return originalSpawn(command, args, options);
		const launchArgs = [...args];
		launchArgs[index] = target;
		const stdio = typeof options.stdio === "string" ? [options.stdio, options.stdio, options.stdio] : options.stdio;
		const child = originalSpawn(command, launchArgs, { ...options, stdio: [...stdio, "ipc"] });
		children.push(child);
		exits.push(new Promise((resolve) => child.once("close", resolve)));
		markers.push(options.env?.SENPI_CLI_ISOLATED_CHILD ?? null);
		child.once("error", (error) => ready.reject(error));
		child.once("message", (message) => ready.resolve(message));
		return child;
	};
	syncBuiltinESMExports();
	let receipt;
	let launchError;
	try {
		process.argv = [process.execPath, cliEntry];
		// The entry awaits its child at module scope, so the deadline bounds the import as well as the receipt.
		[receipt] = await Promise.race([
			Promise.all([ready.promise, import(pathToFileURL(cliEntry).href)]),
			expired.promise,
		]);
	} catch (error) {
		launchError = error.message;
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
			receipt: receipt ?? null,
			launchError: launchError ?? null,
			isolatedChildMarkers: markers,
			childrenSettled: children.every((child) => child.exitCode !== null || child.signalCode !== null),
		}),
	);
	// The deadline can fire while the CLI entry is still loading; ending here keeps it from launching anything later.
	process.exit();
}
