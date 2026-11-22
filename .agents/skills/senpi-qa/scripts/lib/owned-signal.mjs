// Signalling only processes a senpi-qa driver owns (2026-10-22 incident rule). Re-exported by common.mjs.
import { execFileSync } from "node:child_process";
import { readlinkSync } from "node:fs";


/** Thrown instead of sending a signal to a process this driver cannot prove it owns. */
export class OwnedSignalRefusedError extends Error {
	constructor(message) {
		super(`refusing signal: ${message}`);
		this.name = "OwnedSignalRefusedError";
	}
}

/** `{ ppid, pgid, command, cwd }` of a live POSIX process, or `undefined` when it is gone or unreadable. */
export function inspectProcess(pid, platform = process.platform) {
	if (platform === "win32") return undefined;
	let line;
	try {
		line = execFileSync("ps", ["-ww", "-o", "ppid=,pgid=,command=", "-p", String(pid)], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return undefined;
	}
	const match = /^(\d+)\s+(\d+)\s+([\s\S]*)$/.exec(line);
	if (!match) return undefined;
	return { ppid: Number(match[1]), pgid: Number(match[2]), command: match[3], cwd: processCwd(pid, platform) };
}

function processCwd(pid, platform) {
	try {
		if (platform === "linux") return readlinkSync(`/proc/${pid}/cwd`);
		const out = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return out
			.split("\n")
			.find((line) => line.startsWith("n"))
			?.slice(1);
	} catch {
		return undefined;
	}
}

function descendsFrom(pid, ancestor, inspect) {
	let current = pid;
	for (let depth = 0; depth < 64; depth++) {
		const info = inspect(current);
		if (info === undefined || info.ppid <= 1) return false;
		if (info.ppid === ancestor) return true;
		current = info.ppid;
	}
	return false;
}

/**
 * The ONE way a senpi-qa driver signals a process. It refuses (throws `OwnedSignalRefusedError`) unless the target is
 * provably this driver's:
 * - ownership: `spawned` is the handle this driver created for exactly `pid`, or the pid descends from this driver,
 *   or `returned` says the driver's own tool returned this exact pid (e.g. `host ensure --json`);
 * - sandbox: a target that is not a spawned handle must carry `sandboxPath` in its command line or cwd;
 * - identity: `expectCommand`, when given, must appear in its command line.
 * A process-group signal (`group: true`) needs the spawned handle: its group id is the pid this driver created, and
 * POSIX does not reuse a pid while a group with that id exists. Never pick a target by scanning shared /tmp, ps output
 * or socket names. Returns false when the target is already gone.
 */
export function signalOwnedProcess({
	pid,
	signal = "SIGTERM",
	group = false,
	spawned,
	returned = false,
	sandboxPath,
	expectCommand,
	platform = process.platform,
	inspect = (target) => inspectProcess(target, platform),
	kill = (target, sig) => process.kill(target, sig),
	driverPid = process.pid,
}) {
	if (!Number.isInteger(pid) || pid <= 1 || pid === driverPid) throw new OwnedSignalRefusedError(`pid ${pid} is never a target`);
	const handle = spawned !== undefined && spawned !== null && spawned.pid === pid;
	const send = (target) => {
		try {
			kill(target, signal);
			return true;
		} catch (cause) {
			if (cause && cause.code === "ESRCH") return false;
			throw cause;
		}
	};
	if (group) {
		if (!handle) throw new OwnedSignalRefusedError(`a process-group signal to ${pid} needs the handle this driver spawned`);
		if (platform === "win32") return send(pid);
		return send(-pid);
	}
	if (handle && (spawned.exitCode ?? null) !== null) return false;
	if (handle && (spawned.signalCode ?? null) !== null) return false;
	if (platform === "win32" && !handle)
		throw new OwnedSignalRefusedError(`pid ${pid}: only a handle this driver spawned can be signalled on Windows`);
	const info = platform === "win32" ? undefined : inspect(pid);
	if (info === undefined) return handle ? send(pid) : false;
	if (!handle && !returned && !descendsFrom(pid, driverPid, inspect))
		throw new OwnedSignalRefusedError(`pid ${pid} neither descends from this driver nor was returned by its tool`);
	if (!handle && sandboxPath === undefined)
		throw new OwnedSignalRefusedError(`pid ${pid} is not a spawned handle, so it needs the sandbox path to match`);
	if (sandboxPath !== undefined && !info.command.includes(sandboxPath) && !(info.cwd ?? "").includes(sandboxPath))
		throw new OwnedSignalRefusedError(`pid ${pid} carries neither ${sandboxPath} in its command line nor its cwd`);
	if (expectCommand !== undefined && !info.command.includes(expectCommand))
		throw new OwnedSignalRefusedError(`pid ${pid} is not ${expectCommand}`);
	return send(pid);
}
