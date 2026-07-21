import { spawn } from "node:child_process";

const defaultTerminationGraceMs = 12000;

export function runNode(args, timeoutMs) {
	return new Promise((resolveRun, rejectRun) => {
		const child = spawn(process.execPath, args, { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});
		const timeout = setTimeout(() => {
			timedOut = true;
			terminateScenario(child).then(
				() => rejectRun(new Error(`${args.join(" ")} timed out after ${timeoutMs}ms`)),
				rejectRun,
			);
		}, timeoutMs);
		child.once("close", (code) => {
			clearTimeout(timeout);
			if (!timedOut) resolveRun({ code, stdout, stderr });
		});
		child.once("error", (error) => {
			clearTimeout(timeout);
			rejectRun(error);
		});
	});
}

export async function terminateScenario(child, graceMs = defaultTerminationGraceMs) {
	if (!childIsAlive(child)) return;
	const closed = childClose(child);
	child.kill("SIGTERM");
	if (await waitWithin(closed, graceMs)) return;
	if (childIsAlive(child)) child.kill("SIGKILL");
	if (!(await waitWithin(closed, graceMs))) {
		throw new Error(`Timed out terminating scenario process ${child.pid ?? "unknown"}`);
	}
}

function childIsAlive(child) {
	return child.exitCode === null && child.signalCode === null;
}

function childClose(child) {
	return new Promise((resolveClose) => {
		if (!childIsAlive(child)) {
			resolveClose();
			return;
		}
		const onClose = () => resolveClose();
		child.once("close", onClose);
		if (!childIsAlive(child)) {
			child.off("close", onClose);
			resolveClose();
		}
	});
}

async function waitWithin(promise, timeoutMs) {
	let timeout;
	const expired = new Promise((resolveExpired) => {
		timeout = setTimeout(() => resolveExpired(false), timeoutMs);
	});
	const result = await Promise.race([promise.then(() => true), expired]);
	clearTimeout(timeout);
	return result;
}
