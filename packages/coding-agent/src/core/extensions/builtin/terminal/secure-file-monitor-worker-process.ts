import type { ChildProcessWithoutNullStreams } from "node:child_process";

function waitForExit(child: ChildProcessWithoutNullStreams, exit: Promise<void>, timeoutMs: number): Promise<boolean> {
	if (child.exitCode !== null) return Promise.resolve(true);
	return new Promise((resolveExit) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			resolveExit(false);
		}, timeoutMs);
		timer.unref();
		void exit.then(() => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolveExit(true);
		});
	});
}

export async function disposeSecureWorkerProcess(
	child: ChildProcessWithoutNullStreams,
	exit: Promise<void>,
	timeoutMs: number,
): Promise<void> {
	if (child.exitCode !== null) return;
	if (child.stdin.destroyed) child.kill();
	else {
		child.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`, (error) => {
			if (error) child.kill();
		});
	}
	if (await waitForExit(child, exit, timeoutMs)) return;
	child.kill();
	if (await waitForExit(child, exit, timeoutMs)) return;
	child.kill("SIGKILL");
	if (await waitForExit(child, exit, timeoutMs)) return;
	throw new Error("Secure file monitor worker did not exit after forced termination.");
}
