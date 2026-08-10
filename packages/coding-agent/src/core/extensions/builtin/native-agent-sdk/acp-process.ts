import type { ChildProcess } from "node:child_process";
import { reapProcessTree } from "../mcp/process-tree.ts";

export const ACP_PROCESS_GROUP = process.platform !== "win32";

const TERMINATION_WAIT_MS = 500;

export async function terminateAcpProcess(child: ChildProcess): Promise<void> {
	const closed =
		child.exitCode === null && child.signalCode === null
			? new Promise<void>((resolve) => child.once("close", () => resolve()))
			: Promise.resolve();
	const pid = child.pid;
	if (pid === undefined) {
		if (child.exitCode === null && child.signalCode === null) child.kill();
		await closed;
		return;
	}
	if (ACP_PROCESS_GROUP) await reapProcessGroup(pid);
	else await reapProcessTree(pid, { termWaitMs: TERMINATION_WAIT_MS, killWaitMs: TERMINATION_WAIT_MS });
	await closed;
}

async function reapProcessGroup(groupId: number): Promise<void> {
	if (!processGroupAlive(groupId)) return;
	signalProcessGroup(groupId, "SIGTERM");
	await waitForProcessGroup(groupId, TERMINATION_WAIT_MS);
	if (!processGroupAlive(groupId)) return;
	signalProcessGroup(groupId, "SIGKILL");
	await waitForProcessGroup(groupId, TERMINATION_WAIT_MS);
}

async function waitForProcessGroup(groupId: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!processGroupAlive(groupId)) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 25));
	}
}

function processGroupAlive(groupId: number): boolean {
	try {
		process.kill(-groupId, 0);
		return true;
	} catch (error) {
		if (isUnavailableProcess(error)) return false;
		throw error;
	}
}

function signalProcessGroup(groupId: number, signal: "SIGTERM" | "SIGKILL"): void {
	try {
		process.kill(-groupId, signal);
	} catch (error) {
		if (!isUnavailableProcess(error)) throw error;
	}
}

function isUnavailableProcess(error: unknown): boolean {
	return error instanceof Error && "code" in error && (error.code === "ESRCH" || error.code === "EPERM");
}
