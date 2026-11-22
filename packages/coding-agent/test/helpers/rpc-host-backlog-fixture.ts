/**
 * Makes a STOPPED host's public socket stop accepting: the kernel completes connects from the listen
 * backlog without the process running, so a SIGSTOP alone leaves the socket reachable. Filling the
 * backlog with pending connects is what turns "frozen" into "unreachable", the one case where the
 * ensure used to replace a host instead of refusing. POSIX only.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { promisify } from "node:util";

export interface ListenBacklog {
	readonly pending: number;
	release(): void;
}

async function somaxconn(): Promise<number> {
	const raw =
		process.platform === "darwin"
			? (await promisify(execFile)("sysctl", ["-n", "kern.ipc.somaxconn"])).stdout
			: await readFile("/proc/sys/net/core/somaxconn", "utf8");
	const value = Number(raw.trim());
	if (!Number.isInteger(value) || value <= 0) throw new Error(`unreadable somaxconn: ${raw}`);
	return value;
}

function attempt(
	socket: string,
	timeoutMs: number,
): Promise<{ outcome: "connected" | "failed" | "pending"; socket: Socket }> {
	return new Promise((resolve) => {
		const connection = createConnection(socket);
		const timer = setTimeout(() => resolve({ outcome: "pending", socket: connection }), timeoutMs);
		connection.once("connect", () => {
			clearTimeout(timer);
			resolve({ outcome: "connected", socket: connection });
		});
		connection.once("error", () => {
			clearTimeout(timer);
			resolve({ outcome: "failed", socket: connection });
		});
	});
}

/** Opens `somaxconn + 1` connects against a stopped listener and keeps them open until `release`. */
export async function fillListenBacklog(socket: string): Promise<ListenBacklog> {
	const count = (await somaxconn()) + 1;
	const attempts = await Promise.all(Array.from({ length: count }, () => attempt(socket, 1_000)));
	return {
		pending: attempts.filter((entry) => entry.outcome !== "failed").length,
		release: () => {
			for (const entry of attempts) entry.socket.destroy();
		},
	};
}

/** Whether one more client is accepted inside `timeoutMs` - the RED precondition the ensure then meets. */
export async function acceptsWithin(socket: string, timeoutMs: number): Promise<boolean> {
	const probe = await attempt(socket, timeoutMs);
	probe.socket.destroy();
	return probe.outcome === "connected";
}
