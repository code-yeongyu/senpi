import { type ChildProcess, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { isBunBinary } from "../../../config.ts";
import { runtimeExecArgv } from "../../../utils/runtime-exec-argv.ts";
import { resolveCliMainPathAsync } from "../host-cli-entry.ts";
import { TOOL_CHILD_ROLE_ENV } from "./channel.ts";
import { TOOL_CHILD_GENERATION_ENV } from "./entry.ts";
import { TOOL_CHILD_LEDGER_ENV, TOOL_CHILD_REENTRY_ENV, TOOL_CHILD_REFS_ROOT_ENV } from "./launch-env-names.ts";

export interface ToolChildCommand {
	readonly command: string;
	readonly args: readonly string[];
}

/**
 * How this engine re-enters itself as a tool child: a compiled binary boots its embedded entry with the role in its
 * environment, an interpreted install runs its own CLI entry under the same runtime. Never a PATH lookup.
 */
export async function toolChildCommand(compiled: boolean = isBunBinary): Promise<ToolChildCommand> {
	if (compiled) return { command: process.execPath, args: [] };
	return { command: process.execPath, args: [...runtimeExecArgv(), await toolChildEntryPath()] };
}

/** The dedicated role entry beside the CLI entry, so an interpreted child parses none of the CLI graph. */
export async function toolChildEntryPath(cliMainPath?: string): Promise<string> {
	const entry = cliMainPath ?? (await resolveCliMainPathAsync());
	const dedicated = join(dirname(entry), `tool-child-main${extname(entry)}`);
	return (await access(dedicated).then(
		() => true,
		() => false,
	))
		? dedicated
		: entry;
}

export function spawnToolChild(options: {
	readonly generation: number;
	readonly channelEnv: Readonly<Record<string, string>>;
	readonly env: NodeJS.ProcessEnv;
	readonly command: ToolChildCommand;
	readonly cwd: string;
	/** Where both sides write payload references (`<root>/<generation>/`); the server owns and tears it down. */
	readonly refsRoot: string;
	/** This generation's ledger: the child sweeps the owned groups it names if its host disappears. */
	readonly ledgerPath: string;
}): ChildProcess {
	return spawn(options.command.command, [...options.command.args], {
		cwd: options.cwd,
		env: {
			...options.env,
			...options.channelEnv,
			[TOOL_CHILD_ROLE_ENV]: "tool-child",
			[TOOL_CHILD_GENERATION_ENV]: String(options.generation),
			[TOOL_CHILD_REFS_ROOT_ENV]: options.refsRoot,
			// How to re-enter this engine: the Windows launch shim is started the same way the child was.
			[TOOL_CHILD_REENTRY_ENV]: JSON.stringify(options.command),
			[TOOL_CHILD_LEDGER_ENV]: options.ledgerPath,
		},
		// POSIX: the child leads its own group, so its whole tree can be signalled as one. Windows: the job is the handle.
		detached: process.platform !== "win32",
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
}
