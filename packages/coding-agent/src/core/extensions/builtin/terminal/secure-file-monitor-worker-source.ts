import { createRequire } from "node:module";

export const SECURE_FILE_MONITOR_WORKER_FLAG = "--internal-file-monitor-worker";

export const SECURE_FILE_MONITOR_WORKER_SOURCE = String.raw`
const { lstatSync, statSync, watch } = require("node:fs");
const { createInterface } = require("node:readline");
const monitors = new Map();
let poll;
let watcher;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const inspect = (name) => {
	try {
		const value = lstatSync(name, { bigint: true });
		if (!value.isFile() || value.isSymbolicLink()) return { kind: "invalid" };
		return {
			kind: "file",
			fingerprint: [value.dev, value.ino, value.size, value.ctimeNs, value.mtimeNs].join(":"),
		};
	} catch (error) {
		if (error && error.code === "ENOENT") return { kind: "missing" };
		throw error;
	}
};
const dispose = (record) => {
	if (record.settled) return;
	record.settled = true;
	clearTimeout(record.deadline);
	monitors.delete(record.id);
	if (monitors.size === 0) stopSources();
};
const emit = (record, event) => {
	dispose(record);
	send({ type: "event", id: record.id, event });
};
const reconcile = (record) => {
	if (record.settled) return;
	try {
		const current = inspect(record.targetName);
		if (current.kind === "invalid") {
			emit(record, { type: "error", message: "secure target inspection failed" });
		} else if (record.event === "create" && current.kind === "file") {
			emit(record, { type: "created" });
		} else if (
			record.event === "modify" &&
			current.kind === "file" &&
			current.fingerprint !== record.baseline
		) {
			emit(record, { type: "modified" });
		}
	} catch {
		emit(record, { type: "error", message: "secure target inspection failed" });
	}
};
const schedule = (record) => {
	if (record.settled || record.queued) return;
	record.queued = true;
	queueMicrotask(() => {
		record.queued = false;
		reconcile(record);
	});
};
const scheduleAll = () => {
	for (const record of monitors.values()) schedule(record);
};
const stopSources = () => {
	if (poll) clearInterval(poll);
	poll = undefined;
	if (watcher) watcher.close();
	watcher = undefined;
};
const ensureSources = () => {
	if (!watcher) {
		try {
			watcher = watch(process.cwd(), { encoding: "utf8", persistent: false }, scheduleAll);
			watcher.on("error", () => {
				if (watcher) watcher.close();
				watcher = undefined;
			});
		} catch {
			watcher = undefined;
		}
	}
	if (!poll) {
		poll = setInterval(scheduleAll, 1000);
		poll.unref();
	}
};
const validName = (name) =>
	typeof name === "string" &&
	name !== "" &&
	name !== "." &&
	name !== ".." &&
	!name.includes("/") &&
	!name.includes("\\") &&
	!name.includes(":") &&
	!name.includes("\0");
const identity = statSync(".", { bigint: true });
send({ type: "ready", device: String(identity.dev), inode: String(identity.ino) });
createInterface({ input: process.stdin }).on("line", (line) => {
	let request;
	try {
		request = JSON.parse(line);
		if (request.type === "register") {
			if (!validName(request.targetName)) throw new Error("invalid target name");
			const baseline = inspect(request.targetName);
			if (baseline.kind === "invalid") throw new Error("target is not a regular file");
			if (request.event === "create" && baseline.kind !== "missing") throw new Error("target already exists");
			if (request.event === "modify" && baseline.kind !== "file") throw new Error("target does not exist");
			const record = {
				id: request.id,
				targetName: request.targetName,
				event: request.event,
				baseline: baseline.fingerprint,
				queued: false,
				settled: false,
			};
			record.deadline = setTimeout(() => {
				reconcile(record);
				if (!record.settled) emit(record, { type: "timed_out" });
			}, request.timeoutMs);
			record.deadline.unref();
			monitors.set(record.id, record);
			ensureSources();
			send({ type: "registered", requestId: request.requestId });
			schedule(record);
		} else if (request.type === "reconcile") {
			const record = monitors.get(request.id);
			if (record) reconcile(record);
			send({ type: "reconciled", requestId: request.requestId });
		} else if (request.type === "cancel") {
			const record = monitors.get(request.id);
			if (record) dispose(record);
			send({ type: "cancelled", requestId: request.requestId });
		} else if (request.type === "shutdown") {
			for (const record of monitors.values()) dispose(record);
			stopSources();
			process.exit(0);
		}
	} catch (error) {
		send({
			type: "request_error",
			requestId: request && request.requestId,
			message: error instanceof Error ? error.message : String(error),
		});
	}
});
process.stdin.on("end", () => process.exit(0));
`;

export function runSecureFileMonitorWorkerChild(): void {
	const require = createRequire(import.meta.url);
	Function("require", SECURE_FILE_MONITOR_WORKER_SOURCE)(require);
}
