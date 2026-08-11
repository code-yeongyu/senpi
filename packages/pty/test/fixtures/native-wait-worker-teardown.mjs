import process from "node:process";
import { isMainThread, parentPort, Worker } from "node:worker_threads";
import { nativePty } from "../../native/index.js";

if (nativePty.native === null) {
	throw new Error("native PTY Worker fixture requires a host prebuild");
}

function deadline(promise, timeoutMs, message) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), timeoutMs);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

if (!isMainThread) {
	if (parentPort === null) throw new Error("native PTY Worker fixture requires a parent port");
	let output = "";
	const session = nativePty.native.startPtySession(
		{
			command: "sh",
			args: ["-lc", "printf 'PID=%s\\n' $$; while :; do sleep 3600; done"],
			cols: 80,
			rows: 24,
		},
		(chunk) => {
			output += String(chunk);
			const match = /PID=(\d+)/.exec(output);
			if (match?.[1] !== undefined) parentPort.postMessage(Number(match[1]));
		},
	);
	session.waitExit();
} else {
	const worker = new Worker(new URL(import.meta.url));
	const childPid = await deadline(
		new Promise((resolve, reject) => {
			worker.once("message", resolve);
			worker.once("error", reject);
		}),
		5_000,
		"WORKER_PTY_READY_TIMEOUT",
	);
	const workerExit = new Promise((resolve, reject) => {
		worker.once("exit", resolve);
		worker.once("error", reject);
	});
	const termination = worker.terminate();
	await deadline(workerExit, 5_000, "WORKER_TERMINATE_TIMEOUT");
	await termination;

	try {
		process.kill(-childPid, "SIGKILL");
	} catch {
		try {
			process.kill(childPid, "SIGKILL");
		} catch {
			// The process group may already be gone after Worker teardown.
		}
	}
	process.stdout.write("WORKER_TEARDOWN_COMPLETED\n");
}
