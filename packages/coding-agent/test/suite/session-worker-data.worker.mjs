import { parentPort } from "node:worker_threads";
import { sessionWorkerData } from "../../src/modes/rpc/session-worker-data.ts";

const port = sessionWorkerData("probe.port");
const label = sessionWorkerData("probe.label");
parentPort.postMessage({ type: "ready", label: label ?? null, hasPort: port !== undefined });
port?.on("message", (message) => port.postMessage({ echo: message, label }));
