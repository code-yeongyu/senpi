/**
 * `__kill-guard check --vantage <pid> -- <argv...>`: what the runtime shims ask before a real `kill`, `pkill` or
 * `killall` runs (senpi#5349, L2). Hidden: it is reached only through the shims and never listed in help.
 */
import { writeSync } from "node:fs";
import { decideKillGuardRequest, type KillGuardRequestOptions } from "./request.ts";

export const KILL_GUARD_COMMAND = "__kill-guard";
const USAGE = `${KILL_GUARD_COMMAND} check --vantage <pid> -- <command> [arguments...]`;

export interface KillGuardCheckOptions {
	readonly env: NodeJS.ProcessEnv;
	readonly writeError: (text: string) => void;
	readonly platform?: string;
	readonly view?: KillGuardRequestOptions["view"];
}

function positivePid(text: string | undefined): number | undefined {
	if (text === undefined || !/^[1-9]\d*$/.test(text)) return undefined;
	const pid = Number(text);
	return Number.isSafeInteger(pid) ? pid : undefined;
}

/**
 * The exit status the shim acts on: 0 runs the command, 126 refuses it (the refusal is written to stderr), 2 is a
 * malformed call, which the shim treats as a failed judge and so refuses too. A deferred verdict cannot arise on real
 * argv (every word is literal) and runs the command.
 */
export function runKillGuardCheck(args: readonly string[], options: KillGuardCheckOptions): number {
	const [command, verb, flag, vantageText, separator, ...argv] = args;
	const vantagePid = positivePid(vantageText);
	if (
		command !== KILL_GUARD_COMMAND ||
		verb !== "check" ||
		flag !== "--vantage" ||
		vantagePid === undefined ||
		separator !== "--" ||
		argv.length === 0
	) {
		options.writeError(`usage: ${USAGE}\n`);
		return 2;
	}
	const agentPid = positivePid(options.env.SENPI_KILL_GUARD_AGENT_PID);
	if (agentPid === undefined) {
		options.writeError(`${KILL_GUARD_COMMAND}: SENPI_KILL_GUARD_AGENT_PID does not name the agent's pid\n`);
		return 2;
	}
	const verdict = decideKillGuardRequest(
		{ kind: "argv", argv, vantagePid },
		{
			agentPid,
			...(options.platform === undefined ? {} : { platform: options.platform }),
			...(options.view === undefined ? {} : { view: options.view }),
		},
	);
	if (verdict.action !== "refuse") return 0;
	options.writeError(`${verdict.message}\n`);
	return 126;
}

/** The production call: this process's argv and environment; stderr is written synchronously before the exit. */
export function runKillGuardCheckCommand(): number {
	return runKillGuardCheck(process.argv.slice(2), {
		env: process.env,
		writeError: (text) => {
			writeSync(2, text);
		},
	});
}
