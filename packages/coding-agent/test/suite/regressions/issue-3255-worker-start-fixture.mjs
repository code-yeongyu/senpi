import { parentPort, workerData } from "node:worker_threads";
import { holdSessionFile } from "../../../src/core/session-holders.ts";

// senpi#3255: a session worker receives the host's process start through
// workerData, exactly as SessionWorkerClient passes it, so every lease this
// worker writes names the host OS process, not the worker isolate.
const { hostProcessStartedAtMs, file, id, cwd } = workerData;
if (typeof hostProcessStartedAtMs !== "number") throw new Error("hostProcessStartedAtMs is required");
const hold = holdSessionFile(file, id, { cwd, expectExisting: true });
parentPort?.on("message", () => {
	hold.release();
	parentPort.close();
});
parentPort?.postMessage("held");
