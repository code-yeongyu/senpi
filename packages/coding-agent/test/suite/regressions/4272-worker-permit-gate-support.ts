import { parentPort, workerData } from "node:worker_threads";
import { WorkerPermitGate } from "../../../src/modes/rpc/session-worker-permits.ts";

/**
 * A real isolate on one permit block: it asks for a permit, and "builds a payload" (counts one) only once a permit is
 * held, then reports the typed outcome. The isolate is otherwise idle, so it exits as soon as it has answered.
 */
const { block, timeoutMs } = workerData as { block: SharedArrayBuffer; timeoutMs: number };
const outcome = new WorkerPermitGate(block, timeoutMs).acquire();
const built = outcome === "granted" ? 1 : 0;
parentPort?.postMessage({ outcome, built });
