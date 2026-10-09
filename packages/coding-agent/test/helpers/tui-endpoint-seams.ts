/**
 * Shared pieces of the tests that force the order of a terminal endpoint's registration steps: a
 * bounded wait (a step that never happens fails the test instead of hanging it), and dead `tui`
 * endpoints planted the way a terminal that registered and then exited leaves them.
 */
import { spawn } from "node:child_process";
import { resolveTuiSocket } from "../../src/modes/interactive/session-control-registry.ts";
import { createDaemonDirectories, createHostDaemonPaths } from "../../src/modes/rpc/host-daemon-paths.ts";
import { writeHostRegistration } from "../../src/modes/rpc/host-daemon-registration.ts";

export function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const expired = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} did not happen within ${ms} ms`)), ms);
	});
	return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

export function deadPid(): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
		child.once("error", reject);
		child.once("exit", () => {
			if (child.pid === undefined) reject(new Error("child had no pid"));
			else resolve(child.pid);
		});
	});
}

/** A registered `tui` endpoint whose only generation names an exited process and whose socket is gone. */
export async function plantDeadTuiEndpoint(agentDir: string, instanceId: string): Promise<string> {
	const socket = await resolveTuiSocket(agentDir, instanceId);
	const paths = createHostDaemonPaths({ socket, agentDir });
	await writeHostRegistration(paths, {
		record: { pid: await deadPid(), processStartTime: "Thu Jan  1 00:00:00 1970" },
		socket,
		instanceId,
		generation: 0,
		launchProfileId: "tui",
	});
	await createDaemonDirectories(paths, { kind: "tui" });
	return socket;
}
