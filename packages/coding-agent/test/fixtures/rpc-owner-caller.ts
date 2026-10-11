/** A separate ensure caller whose normal exit and SIGKILL close the owner pipe in the kernel. */
import childProcess, { type SpawnOptions } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { Socket } from "node:net";
import { mock } from "node:test";
import { ensureHost } from "../../src/modes/rpc/host-ensure.ts";
import { supervisorLaunch } from "../helpers/rpc-generation-support.ts";
import { MOCK_MODEL, MOCK_PROVIDER } from "../helpers/rpc-hermetic.ts";

const [socket, agentDir, ownership = "caller"] = process.argv.slice(2);
if (!socket || !agentDir) throw new Error("socket and agentDir required");
const spawn = childProcess.spawn;
mock.method(childProcess, "spawn", (command: string, args: readonly string[], options: SpawnOptions) => {
	if (!args[0]?.endsWith("host-lifecycle.ts")) return spawn(command, args, options);
	const stdio = Array.isArray(options.stdio) ? [...options.stdio] : [];
	stdio[1] = "pipe";
	const child = spawn(command, args, { ...options, stdio });
	const pipe = child.stdout;
	if (!(pipe instanceof Socket)) throw new Error("supervisor exit pipe missing");
	// Transfer the read end to the test BEFORE reporting ready. Kernel EOF observes the supervisor's
	// exit even after this owner is SIGKILLed, without pid polling or process-table child guesses.
	process.send?.({ type: "supervisor", pid: child.pid }, pipe);
	return child;
});
syncBuiltinESMExports();
const options = {
	socket,
	agentDir,
	...(ownership === "caller" ? { owner: "caller" as const } : {}),
	policy: { idleExitMs: 60_000 },
	hostArgs: [
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--provider",
		MOCK_PROVIDER,
		"--model",
		MOCK_MODEL,
	],
	_test: { launch: supervisorLaunch },
};
try {
	const ensured = await ensureHost(options);
	ensured.release();
	process.send?.({ type: "ready", pid: ensured.pid, reused: ensured.reused });
	process.on("message", (message) => {
		if (message === "exit") process.disconnect?.();
		if (message === "reuse")
			void ensureHost(options).then((reused) => {
				reused.release();
				process.send?.({ type: "reused", reused: reused.reused });
			});
	});
} catch (cause) {
	process.send?.({ type: "failure", error: String(cause) });
	process.exitCode = 1;
	process.disconnect?.();
}
