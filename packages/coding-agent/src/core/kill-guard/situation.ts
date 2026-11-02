import type {
	BashCommandSegment,
	BashCommandWord,
	BashCommandWrapper,
} from "../extensions/builtin/permission-system/bash-command-segments.ts";
import type { KillGuardContext, KillGuardVerdict } from "./types.ts";
import { defer, refuse } from "./verdict.ts";

const SHELL_NAMES = new Set(["bash", "sh", "zsh", "dash", "ksh", "mksh", "ash", "yash", "posh", "fish", "csh", "tcsh"]);
/** Wrappers that keep `kill` a shell builtin; every other wrapper execs the external `kill`. */
const BUILTIN_KEEPING = new Set(["command", "builtin", "time", "eval", "trap"]);

export const wordsText = (words: readonly BashCommandWord[]) => words.map((word) => word.text);

/** A wrapper after which the command runs with a PATH the runtime layer's shims are not on (DESIGN-12096 R5). */
function resetsPath(wrapper: BashCommandWrapper): boolean {
	const texts = wordsText(wrapper.words);
	switch (wrapper.name) {
		case "sudo":
		case "doas":
		case "chroot":
		case "systemd-run":
			return true;
		case "env":
			return texts.some(
				(text) => text === "-i" || text === "--ignore-environment" || text === "-" || text.startsWith("PATH="),
			);
		case "su":
			return texts.some((text) => text === "-" || text === "-l" || text === "--login");
		case "nix-shell":
			return texts.includes("--pure");
		default:
			return false;
	}
}

/** Where one kill-family invocation runs, which decides whether a later layer can still see its real argv. */
export interface Situation {
	readonly segment: BashCommandSegment;
	readonly resetPath: boolean;
	/** `kill` runs as a shell builtin. */
	readonly builtin: boolean;
	/** The runtime layer will see this invocation's real argv (PATH shims, bash's BASH_ENV wrapper). */
	readonly runtimeCovers: boolean;
}

export function situationOf(segment: BashCommandSegment, context: KillGuardContext): Situation {
	const resetPath = segment.wrappers.some(resetsPath);
	let shell: string = context.shell;
	let afterShell = segment.wrappers;
	for (let index = segment.wrappers.length - 1; index >= 0; index -= 1) {
		const wrapper = segment.wrappers[index];
		if (wrapper !== undefined && SHELL_NAMES.has(wrapper.name)) {
			shell = wrapper.name;
			afterShell = segment.wrappers.slice(index + 1);
			break;
		}
	}
	const shellRuns = shell !== "bun" && shell !== "argv";
	const builtin =
		segment.name === "kill" &&
		!segment.nameIsPath &&
		shellRuns &&
		afterShell.every((wrapper) => BUILTIN_KEEPING.has(wrapper.name));
	const runtimeCovers = !resetPath && !segment.nameIsPath && (!builtin || shell === "bash");
	return { segment, resetPath, builtin, runtimeCovers };
}

/** The verdict for a dynamic word: defer where the runtime layer will see it, refuse UNKNOWN where nothing will. */
export function dynamicVerdict(situation: Situation, what: string): KillGuardVerdict {
	if (situation.runtimeCovers) return defer(`${what} is only known when the command runs`);
	const why = situation.resetPath
		? "a wrapper resets PATH"
		: situation.segment.nameIsPath
			? "the command is named by path"
			: "a shell builtin outside bash";
	return refuse(
		"R5",
		`\`${situation.segment.nameSpelling}\` gets ${what} that is only known when it runs, and nothing judges it then (${why})`,
		"Write the value out literally.",
	);
}
