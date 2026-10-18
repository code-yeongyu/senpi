import type { ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";

const DEFAULT_EXIT_TIMEOUT_MS = 5000;

function hasExited(child: ChildProcess): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
	if (hasExited(child)) return Promise.resolve(true);
	return new Promise((resolve) => {
		let settled = false;
		const finish = (exited: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.removeListener("exit", onExit);
			resolve(exited);
		};
		const onExit = () => finish(true);
		const timer = setTimeout(() => finish(false), timeoutMs);
		child.once("exit", onExit);
		if (hasExited(child)) finish(true);
	});
}

export async function teardownChildProcessesAndRoots<T extends ChildProcess>(
	children: T[],
	roots: string[],
	timeoutMs = DEFAULT_EXIT_TIMEOUT_MS,
	awaitTermAcknowledged?: (child: T) => Promise<void>,
): Promise<void> {
	for (const child of children.splice(0)) {
		if (hasExited(child)) continue;
		child.kill("SIGTERM");
		// Signal-wait, not clock-wait: under load a cooperative child's
		// SIGTERM handler may not get scheduled before the escalation
		// deadline, and killing it then would race the very side effects
		// teardown is meant to observe. When the caller can observe the
		// child's own acknowledgement that it handled SIGTERM, wait for
		// that acknowledgement (no clock) before any deadline applies.
		if (awaitTermAcknowledged) await awaitTermAcknowledged(child);
		if (await waitForExit(child, timeoutMs)) continue;
		child.kill("SIGKILL");
		if (!(await waitForExit(child, timeoutMs))) {
			throw new Error("Child process did not exit after SIGKILL");
		}
	}
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}
