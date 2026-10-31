/**
 * The `launch-shim` role (senpi#3566, plan todo 4, Windows): started by a tool child for an explicit `detached: true`
 * launch. It starts the command outside the child's Job Object, writes `{"pid":N}` on fd 3 so the child can report
 * `command_started{breakaway:true}`, waits, and exits with the command's exit code. The shim itself stays in the job.
 */
import { writeSync } from "node:fs";
import { LAUNCH_SHIM_COMMAND_LINE_ENV } from "./launch-env-names.ts";
import { loadKernel32Process, startBreakaway } from "./windows-breakaway.ts";

const PID_FD = 3;

export function runLaunchShimRole(env: NodeJS.ProcessEnv = process.env): never {
	const commandLine = env[LAUNCH_SHIM_COMMAND_LINE_ENV];
	const kernel = loadKernel32Process();
	if (commandLine === undefined || commandLine === "" || kernel === undefined) {
		process.stderr.write(
			`launch-shim: ${kernel === undefined ? "kernel32 unavailable" : "command line unavailable"}\n`,
		);
		process.exit(70);
	}
	// startBreakaway hands the command an environment without the shim's own role and command line.
	const command = startBreakaway(kernel, commandLine, env);
	writeSync(PID_FD, `${JSON.stringify({ pid: command.pid })}\n`);
	process.exit(command.wait());
}
