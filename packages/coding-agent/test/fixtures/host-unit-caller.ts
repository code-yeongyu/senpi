/**
 * senpi#7099: a short-lived `host ensure` caller. It ensures a real supervised host from inside whatever unit
 * it was started in, prints `{ pid }` on one line, then waits on stdin until its unit is stopped.
 *
 * argv[2] is JSON `{ socket, agentDir, entry, hostArgs, env }`; `entry` is the source supervisor program.
 */
import { ensureHost } from "../../src/modes/rpc/host-ensure.ts";

const input = JSON.parse(process.argv[2] ?? "{}") as {
	socket: string;
	agentDir: string;
	entry: string;
	hostArgs: string[];
	env: Record<string, string>;
};
const host = await ensureHost({
	socket: input.socket,
	agentDir: input.agentDir,
	policy: { idleExitMs: 600_000 },
	hostArgs: input.hostArgs,
	env: input.env,
	_test: {
		readinessTimeoutMs: 60_000,
		launch: (args) => ({ command: process.execPath, args: [input.entry, ...args], reportsStartup: true }),
	},
});
host.release();
process.stdout.write(`${JSON.stringify({ pid: host.pid })}\n`);
process.stdin.resume();
