// Worker for the layered-gate check (senpi#3566 todo 4): installs the production barrier (child_process AND Bun
// globals) and launches through node:child_process. In Bun, child_process launches through Bun.spawn; each call must
// still be gated exactly once.
import childProcess from "node:child_process";
import { existsSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { installWorkerBarrier } from "../../src/modes/rpc/tool-child/gated-worker.ts";

const port = parentPort;
if (port === null) throw new Error("not a worker");
const data = workerData as { barrierClock: SharedArrayBuffer; jobId: string; marker: string };
installWorkerBarrier({ barrierClock: data.barrierClock, jobId: data.jobId });
const detached = childProcess.spawn("sh", ["-c", `echo started > "${data.marker}"`], {
	detached: true,
	stdio: "ignore",
});
const detachedExit = await new Promise<number | null>((resolveExit) => detached.once("exit", resolveExit));
childProcess.execFileSync("true");
port.postMessage({ kind: "result", value: { detachedExit, markerWritten: existsSync(data.marker) } });
