/**
 * Memory and process-identity probes of the offload profiler. Memory is the platform's private
 * footprint (`footprint` on macOS, `RssAnon` on Linux, `PrivateUsage`/PrivateMemorySize on Windows) of
 * the VERIFIED server pid plus its child and descendant pids. The server pid is verified from
 * `host status --all --json` (the endpoint's registered generation) and the host child's `ppid`.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

async function output(command, args) {
	try {
		return (await run(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })).stdout;
	} catch {
		return "";
	}
}

/** Private footprint in MB, or null when the platform probe yields nothing (never a guess). */
export async function footprintMb(pid, platform = process.platform) {
	if (platform === "darwin") {
		const match = /Footprint:\s+([\d.]+)\s+(KB|MB|GB)/.exec(await output("footprint", [String(pid)]));
		if (!match) return null;
		const value = Number(match[1]);
		return Math.round(match[2] === "GB" ? value * 1024 : match[2] === "KB" ? value / 1024 : value);
	}
	if (platform === "linux") {
		const status = await readFile(`/proc/${pid}/status`, "utf8").catch(() => "");
		const match = /RssAnon:\s+(\d+)\s+kB/.exec(status);
		return match ? Math.round(Number(match[1]) / 1024) : null;
	}
	if (platform === "win32") {
		const bytes = Number((await output("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).PrivateMemorySize64`])).trim());
		return bytes > 0 ? Math.round(bytes / 1024 / 1024) : null;
	}
	return null;
}

/** `[{ pid, ppid, command }]` of the whole process table. */
export async function processTable(platform = process.platform) {
	if (platform === "win32") {
		const json = await output("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"]);
		const rows = json ? JSON.parse(json) : [];
		return rows.map((row) => ({ pid: row.ProcessId, ppid: row.ParentProcessId, command: row.CommandLine ?? "" }));
	}
	return (await output("ps", ["-axo", "pid=,ppid=,command="]))
		.split("\n")
		.map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
		.filter(Boolean)
		.map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }));
}

export function descendantsOf(table, pid) {
	const result = [];
	const queue = [pid];
	while (queue.length > 0) {
		const parent = queue.shift();
		for (const row of table) {
			if (row.ppid === parent) {
				result.push(row);
				queue.push(row.pid);
			}
		}
	}
	return result;
}

/**
 * The real server process: the child of the endpoint's registered generation (the supervisor) that
 * runs the `--listen` host. `verified` requires the status endpoint for `socket` to name `supervisorPid`.
 */
export async function verifyServerPid({ statusJson, socket, supervisorPid, table }) {
	const endpoints = Array.isArray(statusJson) ? statusJson : (statusJson?.endpoints ?? []);
	const endpoint = endpoints.find((entry) => entry.socket === socket || entry.public_socket === socket);
	if (endpoint === undefined) return { verified: false, reason: `host status lists no endpoint for ${socket}` };
	const statusPid = endpoint.pid ?? endpoint.generation?.pid;
	if (statusPid !== supervisorPid) return { verified: false, reason: `status pid ${statusPid} != ensured pid ${supervisorPid}` };
	const server = table.find((row) => row.ppid === statusPid && row.command.includes("--listen"));
	if (server === undefined) return { verified: false, reason: `no --listen host child of ${statusPid}` };
	return { verified: true, pid: server.pid, supervisorPid: statusPid, ppidVerified: server.ppid === statusPid };
}

function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}

/**
 * Bounded wait for a process that is not our child to exit (no exit event exists for it); the host
 * writes its CPU profile while exiting, after `stopHost` has returned. True once the pid is gone.
 */
export async function processExited(pid, budgetMs = 30_000) {
	const deadline = Date.now() + budgetMs;
	while (alive(pid)) {
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return true;
}

/** One memory phase: the server's footprint, each child, and the descendant total. */
export async function memorySnapshot(serverPid) {
	const table = await processTable();
	const descendants = descendantsOf(table, serverPid);
	const children = [];
	for (const row of descendants.filter((entry) => entry.ppid === serverPid)) {
		children.push({ pid: row.pid, mb: await footprintMb(row.pid), cmd: row.command.slice(0, 140) });
	}
	let descendantsMb = 0;
	for (const row of descendants) descendantsMb += (await footprintMb(row.pid)) ?? 0;
	return { server_mb: await footprintMb(serverPid), children, descendants_mb: descendantsMb };
}
