import chalk from "chalk";
import { listMovedSessions, type MovedSessionOptions } from "../core/moved-sessions.ts";
import { confirmSameRepositoryRebind } from "./cross-project-session.ts";

export interface ContinueMovedChoice extends MovedSessionOptions {
	readonly cwd: string;
	readonly interactive: boolean;
	readonly confirm: (message: string) => Promise<boolean>;
	readonly out: (line: string) => void;
	readonly err: (line: string) => void;
}

/**
 * `--continue` in a project with no session of its own: the newest session this repository recorded
 * before it moved is offered for the #2182 rebind. Returns its path when the user accepts; without an
 * interactive session nothing is asked and the `--rebind` command is printed instead.
 */
export async function movedSessionToContinue(choice: ContinueMovedChoice): Promise<string | undefined> {
	const [newest] = await listMovedSessions(choice.cwd, choice);
	if (newest === undefined) return undefined;
	if (!choice.interactive) {
		choice.err(
			chalk.yellow(
				`A session of this repository was recorded at ${newest.cwd} before it moved. Use --rebind '${newest.id}' to continue it here.`,
			),
		);
		return undefined;
	}
	choice.out(chalk.yellow(`Session found in different project: ${newest.cwd}`));
	const accepted = await confirmSameRepositoryRebind({
		sessionArg: newest.id,
		cwd: choice.cwd,
		confirm: choice.confirm,
		out: choice.out,
	});
	return accepted ? newest.path : undefined;
}
