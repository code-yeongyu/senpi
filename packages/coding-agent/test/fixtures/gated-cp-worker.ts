// Worker-thread fixture for the gated child_process tests (senpi#3566 todo 4): runs the requested launches through the
// gated module and reports what each one returned.
import realCp from "node:child_process";
import { once } from "node:events";
import { parentPort, workerData } from "node:worker_threads";
import { createGatedChildProcess } from "../../src/modes/rpc/tool-child/gated-child-process.ts";
import { WorkerLaunchClient } from "../../src/modes/rpc/tool-child/worker-launch.ts";

interface Data {
	readonly buffer: SharedArrayBuffer;
	readonly scenario: "apis" | "sync-only";
}

const { buffer, scenario } = workerData as Data;
const port = parentPort;
if (port === null) throw new Error("not a worker");
const client = new WorkerLaunchClient({
	clockBuffer: buffer,
	post: (message) => port.postMessage(message),
	jobId: () => "job-1",
});
const cp = createGatedChildProcess(realCp, client);

if (scenario === "sync-only") {
	const status = cp.spawnSync("true").status;
	port.postMessage({ kind: "result", value: { spawnSync: status } });
} else {
	const spawnSync = cp.spawnSync("sh", ["-c", "exit 3"]).status;
	const owned = cp.spawn("sh", ["-c", "exit 0"], { stdio: "ignore" });
	const ownedPgid = realCp.execFileSync("ps", ["-o", "pgid=", "-p", String(owned.pid)], { encoding: "utf8" }).trim();
	const [ownedExit] = await once(owned, "exit");
	const detached = cp.spawn("sh", ["-c", "exit 0"], { stdio: "ignore", detached: true });
	const [detachedExit] = await once(detached, "exit");
	cp.execFileSync("true");
	port.postMessage({
		kind: "result",
		value: { spawnSync, ownedPid: owned.pid, ownedPgid: Number(ownedPgid), ownedExit, detachedExit },
	});
}
