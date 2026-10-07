import chalk from "chalk";
import type { RepositoryMatch } from "../core/repository-identity.ts";

export type CrossProjectAction = "rebind" | "fork" | "abort" | "fail";

export const FORK_PROMPT = "Fork this session into current directory?";
export const REBIND_PROMPT = "Move this session here and continue it?";

export interface CrossProjectChoice {
	readonly sessionArg: string;
	readonly sessionCwd: string;
	readonly cwd: string;
	readonly match: RepositoryMatch;
	readonly interactive: boolean;
	readonly confirm: (message: string) => Promise<boolean>;
	readonly out: (line: string) => void;
	readonly err: (line: string) => void;
}

/**
 * Decides what `--session <id>` does with a session recorded under another project path. The same
 * repository offers a rebind; a different or unrecognised one keeps the fork prompt. Without an
 * interactive session nothing is asked: the exact commands are printed and the caller exits non-zero.
 */
export async function chooseCrossProjectAction(choice: CrossProjectChoice): Promise<CrossProjectAction> {
	const { sessionArg, sessionCwd, cwd, match } = choice;
	const rebindHint = `If this directory is the same repository moved from ${sessionCwd}, use --rebind '${sessionArg}' to move the session here.`;
	if (!choice.interactive) {
		choice.err(chalk.red(`Session found in different project: ${sessionCwd}`));
		if (match === "same") {
			choice.err(
				chalk.red(
					`${cwd} is the same git repository. Cannot confirm without an interactive session. Use --rebind '${sessionArg}' to move the session here, or --fork '${sessionArg}' to copy it into a new session.`,
				),
			);
			return "fail";
		}
		choice.err(
			chalk.red(
				`Cannot confirm forking without an interactive session. Use --fork '${sessionArg}' to fork it into the current directory, or re-run interactively from ${sessionCwd}.`,
			),
		);
		if (match === "unknown") choice.err(chalk.red(rebindHint));
		return "fail";
	}

	choice.out(chalk.yellow(`Session found in different project: ${sessionCwd}`));
	if (match === "same") {
		if (await confirmSameRepositoryRebind(choice)) return "rebind";
		return "abort";
	}
	if (match === "unknown") choice.out(chalk.dim(rebindHint));
	return (await choice.confirm(FORK_PROMPT)) ? "fork" : "abort";
}

export async function confirmSameRepositoryRebind(
	choice: Pick<CrossProjectChoice, "sessionArg" | "cwd" | "confirm" | "out">,
): Promise<boolean> {
	choice.out(chalk.yellow(`This directory is the same git repository: ${choice.cwd}`));
	choice.out(chalk.dim(`To copy it into a new session instead, use --fork '${choice.sessionArg}'.`));
	return choice.confirm(REBIND_PROMPT);
}
