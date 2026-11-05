import { execFileSync } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createHostDaemonPaths, generationPaths } from "../../src/modes/rpc/host-daemon-paths.ts";
import { readHostRegistration } from "../../src/modes/rpc/host-daemon-registration.ts";
import { processIsLive } from "../../src/utils/process-identity.ts";
import { waitForPidGone } from "../helpers/spawned-host-reaper.ts";
import { hostCliSandbox, onlyJsonLine, runHostCli, sweepHostCliSandboxes } from "./host-cli-support.ts";

afterEach(sweepHostCliSandboxes, 120_000);

function removed(path: string) {
	let close = () => {};
	const promise = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			close();
			reject(new Error("generation did not exit"));
		}, 60_000);
		const watcher = watch(dirname(path), () => {
			if (!existsSync(path)) {
				close();
				resolve();
			}
		});
		close = () => {
			clearTimeout(timer);
			watcher.close();
		};
	});
	return { promise, close };
}

// desktop#3561: a REAL CLI host with a larger extension set, not a listener with hand-written records.
it.skipIf(process.platform === "win32")(
	"recovers a silent CLI generation without authorizing its successor",
	async () => {
		const qa = await hostCliSandbox("foreign");
		const home = join(qa.root, "home");
		await mkdir(home);
		const environment = { HOME: home };
		const cli = (args: string[]) => runHostCli(qa, [...args, "--json"], environment);
		const extension = join(qa.specDir, "foreign.mjs");
		await writeFile(
			extension,
			'export default function(pi) { pi.registerCommand("foreign-proof", { handler: async () => {} }); }\n',
		);
		const spec = join(qa.specDir, "launch.json");
		await writeFile(
			spec,
			JSON.stringify({
				spec_version: 1,
				core: { session_runtime: "in-process", multi_session: true, extensions: ["foreign.mjs"] },
				tunables: { idleExitMs: 600_000, coldStart: "transient" },
			}),
			{ mode: 0o600 },
		);
		const start = await cli(["ensure", "--launch-spec", spec]);
		expect(start.exitCode, `${start.stdout}${start.stderr}`).toBe(0);
		const paths = createHostDaemonPaths({ agentDir: qa.agentDir, socket: qa.socket });
		const registration = await readHostRegistration(paths);
		if (!registration || registration.record.processStartTime === null)
			throw new Error("host has no proven identity");
		const expected = {
			instanceId: registration.instanceId,
			generation: registration.generation,
			pid: registration.record.pid,
			processStartTime: registration.record.processStartTime,
		};
		const files = generationPaths(paths, expected.instanceId);
		const child: { pid: number } = JSON.parse(await readFile(files.childPidFile, "utf8"));
		const before = onlyJsonLine(await cli(["status"]));
		expect(before.launchProfile).toMatchObject({ core: { extensions: [await realpath(extension)] } });
		if (process.platform === "darwin") {
			const sockets = execFileSync("/usr/sbin/lsof", ["-a", "-p", String(expected.pid), "-U", "-Fn"], {
				encoding: "utf8",
			});
			expect(sockets).toContain(qa.socket);
		}
		process.kill(child.pid, "SIGSTOP");
		try {
			const refused = await cli(["ensure"]);
			expect(refused.exitCode).toBe(3);
			expect(onlyJsonLine(refused)).toMatchObject({ reason: "foreign_writer", holder: expected });
			const status = await cli(["status"]);
			expect(status.exitCode).toBe(3);
			expect(onlyJsonLine(status)).toMatchObject({ reachable: false, ...expected });
			const ended = removed(files.dir);
			try {
				const stop = await cli(["stop", "--force", "--expected-generation", JSON.stringify(expected)]);
				expect(stop.exitCode).toBe(0);
				expect(onlyJsonLine(stop)).toMatchObject({ action: "stopped", pid: expected.pid });
				await ended.promise;
			} finally {
				ended.close();
			}
			// The generation's records go before its processes are reaped; wait for each exit, bounded.
			expect(await waitForPidGone(expected.pid, 30_000)).toBe(true);
			expect(await waitForPidGone(child.pid, 30_000)).toBe(true);
			const successor = await cli(["ensure"]);
			expect(successor.exitCode, `${successor.stdout}${successor.stderr}`).toBe(0);
			const current = onlyJsonLine(successor);
			expect(current.instanceId).not.toBe(expected.instanceId);
			const stale = await cli(["stop", "--force", "--expected-generation", JSON.stringify(expected)]);
			expect(stale.exitCode).toBe(3);
			expect(onlyJsonLine(stale)).toMatchObject({ reason: "stale_generation" });
			expect(onlyJsonLine(await cli(["status"]))).toMatchObject({ reachable: true, instanceId: current.instanceId });
		} finally {
			if (processIsLive(child.pid)) process.kill(child.pid, "SIGCONT");
		}
	},
	180_000,
);
