import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface SpawnLoggingWorkerEntry {
	readonly root: string;
	readonly url: URL;
	readonly spawnLog: string;
}

/**
 * A worker entry that runs the real worker core and appends one line to `spawnLog` per spawn, so a
 * test can prove whether the kernel replaced its worker VM. With `blockFirstReady` the first spawn
 * swallows `init` (it never becomes ready) and reports a `readiness-blocked` phase instead.
 */
export async function createSpawnLoggingWorkerEntry(blockFirstReady = false): Promise<SpawnLoggingWorkerEntry> {
	const root = await mkdtemp(join(tmpdir(), "senpi-js-lifecycle-"));
	const entry = join(root, "worker-entry.mjs");
	const spawnLog = join(root, "spawns.txt");
	const gate = join(root, "first-started");
	const coreUrl = pathToFileURL(join(process.cwd(), "src", "kernels", "js", "worker-core.js")).href;
	const source = `
import { closeSync, constants, openSync } from "node:fs";
import { appendFileSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { createWorkerCore } from ${JSON.stringify(coreUrl)};

if (!parentPort) throw new Error("test worker missing parentPort");
appendFileSync(${JSON.stringify(spawnLog)}, "spawn\\n");

const transport = {
  send(message) { parentPort.postMessage(message); },
  onMessage(handler) {
    const listener = (message) => {
      if (${JSON.stringify(blockFirstReady)} && message.type === "init") {
        try {
          const descriptor = openSync(${JSON.stringify(gate)}, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
          closeSync(descriptor);
          parentPort.postMessage({ type: "phase", title: "readiness-blocked" });
          return;
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
        }
      }
      handler(message);
    };
    parentPort.on("message", listener);
    return () => parentPort.off("message", listener);
  },
  close() { parentPort.close(); },
};

createWorkerCore(transport, { cwd: workerData.cwd, parallelPoolWidth: workerData.parallelPoolWidth });
`;
	await writeFile(entry, source);
	await appendFile(spawnLog, "");
	return { root, url: pathToFileURL(entry), spawnLog };
}

export async function spawnCount(entry: SpawnLoggingWorkerEntry): Promise<number> {
	const contents = await readFile(entry.spawnLog, "utf8");
	return contents.split("\n").filter(Boolean).length;
}

export async function removeWorkerEntry(entry: SpawnLoggingWorkerEntry): Promise<void> {
	await rm(entry.root, { recursive: true, force: true });
}
