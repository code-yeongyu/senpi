import childProcess from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultSpawnWorker } from "../../../src/beta/omo-local-update-worker.ts";
import { runPasses } from "../../../src/cli/schedule-watch.ts";
import { createScheduledJob } from "../../../src/core/extensions/builtin/schedule/store.ts";
import { spawnDaemon } from "../../../src/modes/app-server/daemon/spawn.ts";

const root = process.env.SENPI_ARGV_REPRO_ROOT;
const kind = process.env.SENPI_ARGV_REPRO_CASE;
const countFile = join(root, "caller.log");
appendFileSync(countFile, "caller\n");

if (process.env.SENPI_ARGV_REPRO_PARENT_PID) {
	process.send({ kind: "caller-replayed" }, () => {
		process.disconnect();
		process.exitCode = 7;
	});
} else {
	process.env.SENPI_ARGV_REPRO_PARENT_PID = String(process.pid);
	const entry = fileURLToPath(new URL("./2599-eval-child-entry.mjs", import.meta.url));
	const originalSpawn = childProcess.spawn;
	const ready = Promise.withResolvers();
	const children = [];
	const exits = [];
	const deadline = setTimeout(() => ready.reject(new Error("No child execution receipt")), 30_000);
	childProcess.spawn = (command, args, options) => {
		const index = args.findIndex((arg) => arg === entry || /(?:^|[/\\])cli-main\.(?:ts|js)$/.test(arg));
		if (index < 0) return originalSpawn(command, args, options);
		const launchArgs = [...args];
		launchArgs[index] = entry;
		const child = originalSpawn(command, launchArgs, { ...options, stdio: [...options.stdio, "ipc"] });
		children.push(child);
		exits.push(new Promise((resolve) => child.once("close", resolve)));
		child.once("error", (error) => ready.reject(error));
		child.once("message", (message) => ready.resolve(message));
		return child;
	};
	syncBuiltinESMExports();
	let receipt;
	let launchError;
	try {
		try {
			if (kind === "daemon") {
				const socket = process.platform === "win32" ? `\\\\.\\pipe\\${basename(root)}` : join(root, "d.sock");
				await spawnDaemon(
					{ pidFile: join(root, "pid.json"), settingsFile: join(root, "settings.json"), stderrLog: join(root, "daemon.log") },
					{ listen: { kind: "unix", url: `unix://${socket}`, path: socket }, extensions: [] },
					entry,
				);
			} else if (kind === "update") {
				const outcome = defaultSpawnWorker({ agentDir: root, force: false });
				if (!outcome.ok) throw new Error(outcome.message);
			} else {
				const dir = join(root, "schedule");
				await createScheduledJob(
					dir,
					{
						sessionId: "2599-eval-child",
						sessionFile: null,
						cwd: root,
						prompt: "scheduled fixture",
						dueAt: 1,
						everyMs: null,
					},
					1,
				);
				const code = await runPasses(dir, { watch: false, exec: undefined, pollSeconds: 1, timeoutSeconds: 20, concurrency: 1 });
				if (code !== 0) throw new Error(`Schedule pass exited ${code}`);
			}
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
			launchError: launchError ?? null,
			childrenSettled: children.every((child) => child.exitCode !== null || child.signalCode !== null),
		}),
	);
}
