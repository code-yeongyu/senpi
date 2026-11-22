// A job worker (senpi#3566 todo 4): installs the barrier first, then loads the job body, which has no barrier code.
import { parentPort, workerData } from "node:worker_threads";
import { installWorkerBarrier } from "../../src/modes/rpc/tool-child/gated-worker.ts";

installWorkerBarrier(workerData);
const { runPlainSpawn } = await import("./tool-child-plain-job.ts");
parentPort?.postMessage({ kind: "result", status: runPlainSpawn() });
