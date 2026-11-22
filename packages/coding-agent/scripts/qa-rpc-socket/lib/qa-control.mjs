/**
 * Control-file helpers for held barrier states. The server and the child watch
 * `SENPI_TOOL_CHILD_TEST_CONTROL_DIR` with `fs.watch`; the driver releases a hold by creating the named
 * file. `releaseGate` unblocks a `qa_spawn{gate:true}` command: on POSIX it writes the command's FIFO
 * (`gate-<launchId>`), on Windows it signals `waitfor SenpiGate<launchId>`.
 */
import { execFile } from "node:child_process";
import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { QaFailure } from "./qa-failure.mjs";

const run = promisify(execFile);

export function createControl(controlDir, platform = process.platform, readerMs = 30_000) {
	const touch = (name) => writeFile(join(controlDir, name), "");
	return {
		dir: controlDir,
		releaseAck: (launchId) => touch(`release-${launchId}`),
		releaseHeartbeat: () => touch("release-heartbeat"),
		releaseProof: (launchId) => touch(`release-proof-${launchId}`),
		releaseWrite: () => touch("release-write"),
		async releaseGate(launchId) {
			if (platform === "win32") {
				await run("waitfor", ["/si", `SenpiGate${launchId}`]);
				return;
			}
			// Opening a FIFO for write completes once the gated command has it open for read; a command that already ended
			// leaves no reader, and the open would block forever.
			const opening = open(join(controlDir, `gate-${launchId}`), "w");
			let timer;
			const deadline = new Promise((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new QaFailure("gate_reader_gone", `no reader opened gate-${launchId} within ${readerMs} ms`)),
					readerMs,
				);
			});
			const fifo = await Promise.race([opening, deadline]).finally(() => clearTimeout(timer));
			try {
				await fifo.write("go\n");
			} finally {
				await fifo.close();
			}
		},
	};
}
