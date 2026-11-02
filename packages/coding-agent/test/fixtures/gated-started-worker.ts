// Worker for the started-report test (senpi#3566 todo 4, Windows half): installs the production barrier in win32 mode
// so a spawn reports the command's pid with `started`, exactly as a job worker on Windows does.
import realChildProcess from "node:child_process";
import { parentPort, workerData } from "node:worker_threads";
import { createGatedChildProcess } from "../../src/modes/rpc/tool-child/gated-child-process.ts";
import { WorkerLaunchClient } from "../../src/modes/rpc/tool-child/worker-launch.ts";

const port = parentPort;
if (port === null) throw new Error("not a worker");
const data = workerData as { barrierClock: SharedArrayBuffer; jobId: string };
const client = new WorkerLaunchClient({
	clockBuffer: data.barrierClock,
	post: (message) => port.postMessage(message),
	jobId: () => data.jobId,
	skipAckWait: true,
});
const cp = createGatedChildProcess(realChildProcess, client, "win32");
const child = cp.spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
child.once("exit", () => port.postMessage({ kind: "result", pid: child.pid }));
